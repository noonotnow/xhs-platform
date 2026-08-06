export type ManualHandlingMode = 'scheduled' | 'published';
export type ManualReceiptStatus = 'pending' | 'reconciled';

export interface ManualPostHandlingSummary {
  id: string;
  notionPageId: string;
  notionVersion: string;
  mode: ManualHandlingMode;
  receiptStatus: ManualReceiptStatus;
  recordedBy: 'admin' | 'plan';
  warnings: string[];
  scheduledAt?: string;
  manualReconciliationId?: string;
  noteId?: string;
  shareUrl?: string;
  publishedAt?: string;
  reconciledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManualPostHandlingResponse {
  handling: ManualPostHandlingSummary;
  created: boolean;
}
