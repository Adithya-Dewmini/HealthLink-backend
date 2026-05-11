export type ActivityLogEntry = {
  id: number;
  userId: number | null;
  orderId: number | null;
  prescriptionId: string | null;
  queueId: number | null;
  type: string;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ActivityFeedResponse = {
  page: number;
  limit: number;
  items: ActivityLogEntry[];
};
