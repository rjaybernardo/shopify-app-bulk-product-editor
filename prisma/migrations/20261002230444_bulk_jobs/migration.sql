-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "returnWindowDays" INTEGER NOT NULL DEFAULT 30,
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "autoRefundOnReceipt" BOOLEAN NOT NULL DEFAULT true,
    "restockOnReceipt" BOOLEAN NOT NULL DEFAULT true,
    "notifyMerchantEmail" TEXT,
    "portalIntro" TEXT NOT NULL DEFAULT 'Start a return in a few clicks. You''ll need your order number and the email used at checkout.',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReturnRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyReturnId" TEXT,
    "returnName" TEXT,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "source" TEXT NOT NULL DEFAULT 'PORTAL',
    "customerNote" TEXT,
    "declineReason" TEXT,
    "declineNote" TEXT,
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "labelUrl" TEXT,
    "labelToken" TEXT,
    "labelCost" REAL,
    "refundAmount" REAL,
    "currencyCode" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" DATETIME,
    "labelSentAt" DATETIME,
    "receivedAt" DATETIME,
    "refundedAt" DATETIME,
    "closedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReturnLineItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "returnRequestId" TEXT NOT NULL,
    "fulfillmentLineItemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "imageUrl" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" REAL NOT NULL,
    "reasonHandle" TEXT NOT NULL,
    "reasonName" TEXT NOT NULL,
    "customerNote" TEXT,
    CONSTRAINT "ReturnLineItem_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReturnEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "returnRequestId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReturnEvent_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BulkJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SNAPSHOTTING',
    "phase" TEXT,
    "spec" TEXT NOT NULL,
    "warnings" TEXT NOT NULL DEFAULT '[]',
    "bulkOperationId" TEXT,
    "bulkObjectCount" INTEGER NOT NULL DEFAULT 0,
    "bulkTotal" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "variantCount" INTEGER NOT NULL DEFAULT 0,
    "changeCount" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "rollbackOfId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BulkJob_rollbackOfId_fkey" FOREIGN KEY ("rollbackOfId") REFERENCES "BulkJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BulkJobItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "imageUrl" TEXT,
    "before" TEXT NOT NULL,
    "after" TEXT NOT NULL,
    "changeCount" INTEGER NOT NULL,
    "productLine" INTEGER,
    "variantLine" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    CONSTRAINT "BulkJobItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BulkJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRequest_shopifyReturnId_key" ON "ReturnRequest"("shopifyReturnId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRequest_labelToken_key" ON "ReturnRequest"("labelToken");

-- CreateIndex
CREATE INDEX "ReturnRequest_shop_status_idx" ON "ReturnRequest"("shop", "status");

-- CreateIndex
CREATE INDEX "ReturnRequest_shop_requestedAt_idx" ON "ReturnRequest"("shop", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BulkJob_rollbackOfId_key" ON "BulkJob"("rollbackOfId");

-- CreateIndex
CREATE INDEX "BulkJob_shop_createdAt_idx" ON "BulkJob"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "BulkJob_bulkOperationId_idx" ON "BulkJob"("bulkOperationId");

-- CreateIndex
CREATE INDEX "BulkJobItem_jobId_idx" ON "BulkJobItem"("jobId");
