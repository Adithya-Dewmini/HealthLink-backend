export type CartItemInput = {
  marketplaceProductId: number;
  quantity: number;
};

export type UpdateCartItemInput = {
  id: number;
  quantity: number;
};

export type CartProductSummary = {
  id: string;
  inventoryItemId: number;
  name: string;
  genericName: string | null;
  brand: string | null;
  category: string | null;
  imageUrl: string | null;
  price: number;
  discountPrice: number | null;
  requiresPrescription: boolean;
  inStock: boolean;
  stockQuantity: number;
  availableStock: number;
  pharmacyId: number;
};

export type CartItemSummary = {
  id: number;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  product: CartProductSummary;
};

export type CartSummary = {
  id: number;
  patientId: number;
  pharmacyId: number | null;
  pharmacyName: string | null;
  itemCount: number;
  subtotal: number;
  discountTotal: number;
  total: number;
  items: CartItemSummary[];
};
