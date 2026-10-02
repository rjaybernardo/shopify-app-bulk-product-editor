import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { advanceJobForBulkOperation } from "../services/jobs.server";

// bulk_operations/finish: move the owning job to its next step without waiting for a page poll.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}: ${payload.status}`);

  if (admin && payload.admin_graphql_api_id) {
    await advanceJobForBulkOperation(
      admin,
      shop,
      payload.admin_graphql_api_id as string,
    );
  }

  return new Response();
};
