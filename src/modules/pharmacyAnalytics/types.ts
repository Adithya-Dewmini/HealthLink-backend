export type PharmacyAnalyticsDashboard = {
  overview: {
    totalOrders: number;
    completedOrders: number;
    pendingOrders: number;
    cancelledOrders: number;
    totalRevenue: number;
    fulfillmentSuccessRate: number;
    cancellationRate: number;
    prescriptionVolume: number;
  };
  topMedicines: Array<{
    medicineId: number;
    name: string;
    quantitySold: number;
    revenue: number;
  }>;
  lowStockMedicines: Array<{
    medicineId: number;
    name: string;
    quantity: number;
    reservedQuantity: number;
    availableStock: number;
  }>;
  orderTrends: Array<{
    date: string;
    orderCount: number;
    revenue: number;
  }>;
  forecastHighlights: Array<{
    medicineId: number;
    name: string;
    predictedDemand: number;
    recommendedReorderQuantity: number;
    shortageRisk: "low" | "medium" | "high";
  }>;
};
