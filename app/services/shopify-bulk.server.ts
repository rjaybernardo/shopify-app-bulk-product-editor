import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// Typed wrappers around the Admin GraphQL operations the editor uses (2026-07).
// Every operation here was validated against the Admin schema.

export type Admin = Pick<AdminApiContext, "graphql">;

type UserError = { field?: string[] | null; message: string };

async function run<T>(
  admin: Admin,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const json = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data as T;
}

function assertNoUserErrors(errors: UserError[] | undefined) {
  if (errors?.length) throw new Error(errors.map((e) => e.message).join("; "));
}

// --- Catalog reads for the editor UI -------------------------------------------------------

// 2026-07 collections are built from sources. Products can be picked into a collection through a
// product-targeted conditions source; one with no conditions is what used to be a "custom" collection.
type CollectionSource = {
  __typename: string;
  id: string;
  targetType?: string;
  inclusion?: { conditions: { __typename: string }[] };
};

const COLLECTION_SOURCES = `sources {
  __typename
  id
  ... on CollectionConditionsSource {
    targetType
    inclusion { conditions { __typename } }
  }
}`;

function pickableSource(sources: CollectionSource[]) {
  const candidates = sources.filter(
    (s) =>
      s.__typename === "CollectionConditionsSource" &&
      s.targetType === "PRODUCTS",
  );
  return (
    candidates.find((s) => !s.inclusion?.conditions.length) ?? candidates[0]
  );
}

export type CollectionOption = {
  id: string;
  title: string;
  // Can products be picked in through a product-targeted source?
  editable: boolean;
  // Has automated conditions: products matching them stay in even after a removal.
  automated: boolean;
};

export async function listCollections(admin: Admin) {
  const data = await run<{
    collections: {
      nodes: { id: string; title: string; sources: CollectionSource[] }[];
    };
  }>(
    admin,
    `#graphql
    query BpeCollections {
      collections(first: 250, sortKey: TITLE) {
        nodes {
          id
          title
          ${COLLECTION_SOURCES}
        }
      }
    }`,
  );
  return data.collections.nodes.map<CollectionOption>((c) => {
    const source = pickableSource(c.sources);
    return {
      id: c.id,
      title: c.title,
      editable: Boolean(source),
      automated: c.sources.some(
        (s) =>
          s.__typename !== "CollectionConditionsSource" ||
          Boolean(s.inclusion?.conditions.length),
      ),
    };
  });
}

export type ProductPreview = {
  id: string;
  title: string;
  status: string;
  imageUrl: string | null;
  variants: number;
};

export async function previewProducts(admin: Admin, query: string) {
  const data = await run<{
    products: {
      nodes: {
        id: string;
        title: string;
        status: string;
        featuredMedia: { preview: { image: { url: string } | null } } | null;
        variantsCount: { count: number } | null;
      }[];
    };
    productsCount: { count: number; precision: string } | null;
  }>(
    admin,
    `#graphql
    query BpePreviewProducts($query: String!) {
      products(first: 8, query: $query, sortKey: TITLE) {
        nodes {
          id
          title
          status
          featuredMedia { preview { image { url(transform: { maxWidth: 80 }) } } }
          variantsCount { count }
        }
      }
      productsCount(query: $query) { count precision }
    }`,
    { query },
  );
  return {
    count: data.productsCount?.count ?? 0,
    atLeast: data.productsCount?.precision === "AT_LEAST",
    products: data.products.nodes.map<ProductPreview>((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      imageUrl: p.featuredMedia?.preview.image?.url ?? null,
      variants: p.variantsCount?.count ?? 0,
    })),
  };
}

// --- Bulk operations -------------------------------------------------------------------------

// Read side. Two nested connections (collections, variants) stay inside the bulk query limits:
// at most five connections, nested at most two levels deep.
export function snapshotQuery(productQuery: string) {
  return `{
  products(query: ${JSON.stringify(productQuery)}) {
    edges {
      node {
        id
        title
        handle
        descriptionHtml
        vendor
        productType
        status
        tags
        featuredMedia { preview { image { url(transform: { maxWidth: 120 }) } } }
        collections { edges { node { id } } }
        variants { edges { node { id title sku price compareAtPrice } } }
      }
    }
  }
}`;
}

export async function startBulkQuery(admin: Admin, query: string) {
  const data = await run<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
    mutation BpeRunBulkQuery($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { query },
  );
  assertNoUserErrors(data.bulkOperationRunQuery.userErrors);
  return data.bulkOperationRunQuery.bulkOperation!.id;
}

// Write side. Each line of the uploaded JSONL file becomes the variables for one call.
export const PRODUCT_UPDATE_MUTATION = `mutation BpeProductUpdate($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id }
    userErrors { field message }
  }
}`;

export const VARIANTS_UPDATE_MUTATION = `mutation BpeVariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    product { id }
    userErrors { field message }
  }
}`;

async function stageJsonl(admin: Admin, jsonl: string) {
  const data = await run<{
    stagedUploadsCreate: {
      stagedTargets: {
        url: string;
        parameters: { name: string; value: string }[];
      }[];
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
    mutation BpeStageUpload($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          resource: "BULK_MUTATION_VARIABLES",
          filename: "bulk_op_vars.jsonl",
          mimeType: "text/jsonl",
          httpMethod: "POST",
        },
      ],
    },
  );
  assertNoUserErrors(data.stagedUploadsCreate.userErrors);
  const target = data.stagedUploadsCreate.stagedTargets[0];

  // The signed policy fields must come first and the file last.
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append(
    "file",
    new Blob([jsonl], { type: "text/jsonl" }),
    "bulk_op_vars.jsonl",
  );
  const upload = await fetch(target.url, { method: "POST", body: form });
  if (!upload.ok) {
    throw new Error(`Staged upload failed (${upload.status})`);
  }
  const key = target.parameters.find((p) => p.name === "key")?.value;
  if (!key) throw new Error("Staged upload did not return a key");
  return key;
}

export async function startBulkMutation(
  admin: Admin,
  mutation: string,
  variables: object[],
) {
  const path = await stageJsonl(
    admin,
    variables.map((v) => JSON.stringify(v)).join("\n") + "\n",
  );
  const data = await run<{
    bulkOperationRunMutation: {
      bulkOperation: { id: string } | null;
      userErrors: UserError[];
    };
  }>(
    admin,
    `#graphql
    mutation BpeRunBulkMutation($mutation: String!, $path: String!) {
      bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { mutation, path },
  );
  assertNoUserErrors(data.bulkOperationRunMutation.userErrors);
  return data.bulkOperationRunMutation.bulkOperation!.id;
}

export type BulkOperation = {
  id: string;
  status:
    | "CREATED"
    | "RUNNING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELED"
    | "CANCELING"
    | "EXPIRED";
  errorCode: string | null;
  objectCount: string;
  rootObjectCount: string;
  url: string | null;
  partialDataUrl: string | null;
};

export async function getBulkOperation(admin: Admin, id: string) {
  const data = await run<{ bulkOperation: BulkOperation | null }>(
    admin,
    `#graphql
    query BpeBulkOperation($id: ID!) {
      bulkOperation(id: $id) {
        id
        status
        errorCode
        objectCount
        rootObjectCount
        url
        partialDataUrl
      }
    }`,
    { id },
  );
  if (!data.bulkOperation) throw new Error(`Bulk operation ${id} not found`);
  return data.bulkOperation;
}

export async function downloadText(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download results (${res.status})`);
  return res.text();
}

// --- Collections ---------------------------------------------------------------------------
// Membership changes don't fit productUpdate. In 2026-07 they are manual selections on a
// collection's conditions source, changed through collectionUpdate (250 products per call).

export async function getPickableSourceId(admin: Admin, collectionId: string) {
  const data = await run<{
    collection: { sources: CollectionSource[] } | null;
  }>(
    admin,
    `#graphql
    query BpeCollectionSources($id: ID!) {
      collection(id: $id) {
        ${COLLECTION_SOURCES}
      }
    }`,
    { id: collectionId },
  );
  if (!data.collection) throw new Error("Collection no longer exists");
  const source = pickableSource(data.collection.sources);
  if (!source) {
    throw new Error(
      "This collection has no source that products can be added to",
    );
  }
  return source.id;
}

export async function updateCollectionSelections(
  admin: Admin,
  collectionId: string,
  sourceId: string,
  change: { add?: string[]; remove?: string[] },
) {
  const data = await run<{
    collectionUpdate: { userErrors: UserError[] };
  }>(
    admin,
    `#graphql
    mutation BpeCollectionSelections(
      $id: ID!
      $sourceId: ID!
      $add: [CollectionInclusionProductSelectionInput!]
      $remove: [CollectionInclusionProductSelectionInput!]
    ) {
      collectionUpdate(
        collection: {
          id: $id
          sourcesToUpdate: [
            {
              condition: {
                id: $sourceId
                inclusion: { selectionsToAdd: $add, selectionsToRemove: $remove }
              }
            }
          ]
        }
      ) {
        collection { id }
        userErrors { field message }
      }
    }`,
    {
      id: collectionId,
      sourceId,
      add: change.add?.map((productId) => ({ productId })) ?? [],
      remove: change.remove?.map((productId) => ({ productId })) ?? [],
    },
  );
  assertNoUserErrors(data.collectionUpdate.userErrors);
}
