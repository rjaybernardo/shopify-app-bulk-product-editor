import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { previewProducts } from "../services/shopify-bulk.server";

// Resource route behind the editor's live "N products match" preview.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const query = new URL(request.url).searchParams.get("q") ?? "";
  return previewProducts(admin, query);
};
