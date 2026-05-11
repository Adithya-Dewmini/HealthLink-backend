export type MarketplaceStoreProduct = {
  id: string;
  inventoryItemId: number;
  name: string;
  genericName: string | null;
  brand: string | null;
  description: string | null;
  category: string | null;
  imageUrl: string | null;
  price: number;
  discountPrice: number | null;
  requiresPrescription: boolean;
  isFeatured: boolean;
  isActive: boolean;
  inStock: boolean;
  stockQuantity: number;
  pharmacyId: number;
};

export type MarketplaceStoreResponse = {
  pharmacy: {
    id: number;
    name: string;
    location: string | null;
    imageUrl: string | null;
    logoUrl: string | null;
    coverImageUrl: string | null;
    rating: number | null;
    status: string | null;
    verificationStatus: string;
  };
  categories: string[];
  featuredProducts: MarketplaceStoreProduct[];
  products: MarketplaceStoreProduct[];
};

export type CreateMarketplaceProductInput = {
  inventoryItemId: number;
  name?: string;
  genericName?: string | null;
  brand?: string | null;
  description?: string | null;
  category?: string | null;
  price: number;
  discountPrice?: number | null;
  imageUrl?: string | null;
  requiresPrescription?: boolean;
  isFeatured?: boolean;
  isActive?: boolean;
};

export type UpdateMarketplaceProductInput = {
  id: number;
  name?: string;
  genericName?: string | null;
  brand?: string | null;
  description?: string | null;
  category?: string | null;
  price?: number;
  discountPrice?: number | null;
  imageUrl?: string | null;
  requiresPrescription?: boolean;
  isFeatured?: boolean;
  isActive?: boolean;
};

export type UpdateMarketplaceVisibilityInput = {
  id: number;
  isActive: boolean;
};
