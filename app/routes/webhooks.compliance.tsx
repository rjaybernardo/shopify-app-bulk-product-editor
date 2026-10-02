import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory privacy webhooks: customers/data_request, customers/redact, shop/redact.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      // The app stores product data only; it holds no customer data.
      break;
    case "SHOP_REDACT":
      await db.bulkJob.deleteMany({ where: { shop } });
      break;
  }

  return new Response();
};
