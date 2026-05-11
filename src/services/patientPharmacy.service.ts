import pool from "../config/db";

export type PatientPharmacyItem = {
  id: string;
  name: string;
  location: string | null;
  image_url: string | null;
  logo_url: string | null;
  cover_image_url: string | null;
  rating: number | null;
  status: string | null;
  verification_status: string;
  is_open: boolean | null;
};

type ListPatientPharmaciesOptions = {
  search?: string;
};

export const listPatientPharmacies = async (
  options: ListPatientPharmaciesOptions = {}
) => {
  const params: string[] = [];
  const whereClauses = [
    `LOWER(COALESCE(p.verification_status, 'pending')) = 'approved'`,
  ];

  if (typeof options.search === "string" && options.search.trim().length > 0) {
    params.push(`%${options.search.trim().toLowerCase()}%`);
    whereClauses.push(`
      (
        LOWER(p.name) LIKE $${params.length}
        OR LOWER(COALESCE(p.location, '')) LIKE $${params.length}
      )
    `);
  }

  const result = await pool.query<PatientPharmacyItem>(
    `
    SELECT
      p.id::text AS id,
      p.name,
      COALESCE(p.location, 'Not provided') AS location,
      p.image_url,
      p.logo_url,
      p.cover_image_url,
      p.rating::float AS rating,
      COALESCE(p.status, 'Available') AS status,
      LOWER(COALESCE(p.verification_status, 'pending')) AS verification_status,
      CASE
        WHEN LOWER(COALESCE(p.status, 'active')) IN ('inactive', 'disabled', 'closed') THEN FALSE
        ELSE TRUE
      END AS is_open
    FROM pharmacies p
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY
      p.name ASC
    LIMIT 100
    `,
    params
  );

  return {
    items: result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      location: row.location || "Not provided",
      imageUrl: row.image_url || row.cover_image_url || row.logo_url,
      image_url: row.image_url,
      logoUrl: row.logo_url,
      logo_url: row.logo_url,
      coverImageUrl: row.cover_image_url,
      cover_image_url: row.cover_image_url,
      rating: row.rating,
      status: row.status || "Available",
      verificationStatus: row.verification_status,
      isOpen: row.is_open,
    })),
  };
};
