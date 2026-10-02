# Bulk Product Editor

An embedded Shopify app for editing hundreds of products at once: prices, compare-at prices,
tags, collections, titles, descriptions, vendor, product type and status. Changes come from
a rule builder or from a CSV/Excel upload (including Shopify's own product export). Every
change is previewed before→after, applied with the **GraphQL Bulk Operations API** with live
progress, and can be undone in one click.

## Flow

```
Rule builder ─┐                                   ┌─ productUpdate             (bulk mutation 1)
              ├─▶ bulkOperationRunQuery ─▶ READY ─┼─ productVariantsBulkUpdate (bulk mutation 2)
CSV / Excel  ─┘   (snapshot → JSONL)    preview   └─ collectionUpdate selections (250 per call)
                                           │                          │
                                        discard            COMPLETED / PARTIAL / FAILED
                                                                      │
                                                         Undo = new job from saved "before"
```

- **Snapshot**: one bulk query reads the selected products with their variants and collection
  membership, so there is no query cost limit to page around. CSV imports snapshot the whole
  catalog and match rows by ID, handle or SKU in memory.
- **Plan**: rules or rows become a desired state per product; `diffProduct` keeps only real
  differences and stores the exact `before` and `after` of each changed field.
- **Apply**: the plan is written to JSONL, staged with `stagedUploadsCreate`
  (`BULK_MUTATION_VARIABLES`) and run with `bulkOperationRunMutation`. Result lines map back
  to products by `__lineNumber`, so failures are reported per product.
- **Progress**: no background worker. `advanceJob()` runs when the job page polls (every 2s)
  and when the `bulk_operations/finish` webhook arrives, so a job finishes even with the tab
  closed. A row lock (`lockedUntil`) stops the poll and the webhook from both starting the
  next step.
- **Undo**: a rollback job swaps each item's `before` and `after` and runs through the same
  pipeline, collection membership included.

## Features

| Feature | Where |
| --- | --- |
| Rule builder: product filter with live match count, or resource-picker selection | `app/routes/app.edit.tsx` |
| Price ops (set, ±%, ±amount, .99/.95/whole rounding), compare-at (set, clear, from price, % above) | `app/lib/operations.ts` |
| CSV/TSV/Excel import with Shopify export header aliases and per-row warnings | `app/routes/app.import.tsx`, `app/lib/csv.ts` |
| Preview with before → after per field, warnings, stale-preview refresh | `app/routes/app.jobs.$id.tsx` |
| Job engine: snapshot, plan, phases, result mapping, locking, undo | `app/services/jobs.server.ts` |
| Admin API wrappers (validated against 2026-07) | `app/services/shopify-bulk.server.ts` |
| History and dashboard (products updated, field changes, estimated time saved) | `app/routes/app.jobs._index.tsx`, `app/routes/app._index.tsx` |
| Bulk operation webhook, privacy webhooks | `app/routes/webhooks.*.tsx` |

## API notes (2026-07)

- `collectionAddProductsV2` and `collectionRemoveProducts` are deprecated in 2026-07. Membership
  changes use `collectionUpdate` → `sourcesToUpdate.condition.inclusion.selectionsToAdd/Remove`
  on the collection's product-targeted conditions source. In collections with automated
  conditions, products that match the conditions stay in after a removal.
- Bulk status is read with `bulkOperation(id:)`. From 2026-01, up to five bulk operations can run
  per shop. The app still allows only one applying job per shop, so two jobs can't overwrite
  each other's products.
- Product searches always send an explicit `status:` list, because the search can default to
  active products only.

## Running locally

```sh
npm install
npm run config:link   # create or link the app in your Partner Dashboard (fills client_id)
npm run dev
npm test              # unit tests plus a full lifecycle test against a fake Admin API
```

Scopes: `read_products,write_products`. Limits: 10,000 products per rule-based job and 20,000
rows per import.
