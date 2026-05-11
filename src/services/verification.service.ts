import pool from "../config/db";

type HttpError = Error & { statusCode?: number };

export type VerificationEntityType = "clinic" | "doctor" | "pharmacy";
export type VerificationStatus = "pending" | "approved" | "rejected" | "suspended";

type VerificationEntityProfile = {
  entityId: string;
  entityType: VerificationEntityType;
  entityName: string;
  status: VerificationStatus;
  submittedAt: string | null;
  verifiedAt: string | null;
  verificationNotes: string | null;
};

type VerificationListItem = {
  entityId: string;
  entityName: string;
  entityType: VerificationEntityType;
  submittedAt: string | null;
  status: VerificationStatus;
  documentCount: number;
  owner: {
    id: number;
    name: string;
    email: string | null;
    role: string | null;
  } | null;
  assignedReviewer: null;
  lastAction: {
    id: string;
    status: VerificationStatus;
    note: string | null;
    reviewedAt: string;
    reviewedBy: {
      id: number;
      name: string;
      email: string | null;
    } | null;
  } | null;
};

const createStatusError = (message: string, statusCode: number) => {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
};

const buildApprovalStatusMessage = (
  entityLabel: "Medical center" | "Doctor" | "Pharmacy",
  status: string
) => {
  switch (status) {
    case "pending":
      return `${entityLabel} approval is still pending`;
    case "rejected":
      return `${entityLabel} approval was rejected`;
    case "suspended":
      return `${entityLabel} access is suspended`;
    default:
      return `${entityLabel} is not verified`;
  }
};

const normalizeApprovalField = (value: unknown, fallback = "pending") => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized.length > 0 ? normalized : fallback;
};

const resolveClinicApprovalStatus = (row: {
  status: string | null;
  verification_status: string | null;
}) => {
  const verificationStatus = normalizeApprovalField(row.verification_status, "pending");
  const status = normalizeApprovalField(row.status, "");

  if (verificationStatus === "approved") {
    return "approved";
  }

  if (verificationStatus === "rejected" || verificationStatus === "suspended") {
    return verificationStatus;
  }

  // Legacy fallback for rows that were approved through the old status field
  // before verification_status was kept in sync.
  if (verificationStatus === "pending" && status === "approved") {
    return "approved";
  }

  if (status === "rejected" || status === "suspended") {
    return status;
  }

  return verificationStatus;
};

const isClinicOperationallyActive = (value: unknown) => {
  const normalized = normalizeApprovalField(value, "active");
  return normalized === "active" || normalized === "approved";
};

const normalizeEntityType = (value: string): VerificationEntityType => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "clinic" || normalized === "doctor" || normalized === "pharmacy") {
    return normalized;
  }
  throw createStatusError("Invalid verification entity type", 400);
};

const normalizeStatus = (value: string): VerificationStatus => {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "pending" ||
    normalized === "approved" ||
    normalized === "rejected" ||
    normalized === "suspended"
  ) {
    return normalized;
  }
  throw createStatusError("Invalid verification status", 400);
};

const getEntityConfig = (entityType: VerificationEntityType) => {
  switch (entityType) {
    case "clinic":
      return {
        table: "medical_centers",
        idColumn: "id",
        nameColumn: "entity.name",
        ownerJoin: `
          LEFT JOIN users owner_user ON owner_user.id = entity.admin_id
        `,
        ownerFields: `
          owner_user.id AS owner_id,
          owner_user.name AS owner_name,
          owner_user.email AS owner_email,
          owner_user.role AS owner_role
        `,
        metadataSql: `
          SELECT
            entity.address,
            entity.phone,
            entity.email,
            entity.status,
            entity.city
          FROM medical_centers entity
          WHERE entity.id = $1::uuid
          LIMIT 1
        `,
      };
    case "doctor":
      return {
        table: "doctors",
        idColumn: "id",
        nameColumn: "COALESCE(owner_user.name, 'Doctor')",
        ownerJoin: `
          LEFT JOIN users owner_user ON owner_user.id = entity.user_id
        `,
        ownerFields: `
          owner_user.id AS owner_id,
          owner_user.name AS owner_name,
          owner_user.email AS owner_email,
          owner_user.role AS owner_role
        `,
        metadataSql: `
          SELECT
            entity.specialization,
            entity.license_number,
            entity.experience_years,
            entity.medical_center_id,
            entity.consultation_fee
          FROM doctors entity
          WHERE entity.id = $1::int
          LIMIT 1
        `,
      };
    case "pharmacy":
      return {
        table: "pharmacies",
        idColumn: "id",
        nameColumn: "entity.name",
        ownerJoin: `
          LEFT JOIN LATERAL (
            SELECT u.id, u.name, u.email, u.role
            FROM pharmacist_pharmacies pp
            JOIN users u ON u.id = pp.user_id
            WHERE pp.pharmacy_id = entity.id
            ORDER BY pp.created_at ASC
            LIMIT 1
          ) owner_user ON TRUE
        `,
        ownerFields: `
          owner_user.id AS owner_id,
          owner_user.name AS owner_name,
          owner_user.email AS owner_email,
          owner_user.role AS owner_role
        `,
        metadataSql: `
          SELECT
            entity.location,
            entity.status,
            entity.rating,
            entity.logo_url,
            entity.cover_image_url
          FROM pharmacies entity
          WHERE entity.id = $1::int
          LIMIT 1
        `,
      };
  }
};

const castIdSql = (entityType: VerificationEntityType, placeholder: string) =>
  entityType === "clinic" ? `${placeholder}::uuid` : `${placeholder}::int`;

type EntityRow = {
  entity_id: string;
  entity_name: string;
  verification_status: string;
  submitted_at: string | null;
  verified_at: string | null;
  verification_notes: string | null;
  owner_id: number | null;
  owner_name: string | null;
  owner_email: string | null;
  owner_role: string | null;
};

const getEntityRow = async (entityType: VerificationEntityType, entityId: string) => {
  const config = getEntityConfig(entityType);
  const result = await pool.query<EntityRow>(
    `
    SELECT
      entity.${config.idColumn}::text AS entity_id,
      ${config.nameColumn} AS entity_name,
      LOWER(COALESCE(entity.verification_status, 'pending')) AS verification_status,
      entity.created_at::text AS submitted_at,
      entity.verified_at::text AS verified_at,
      entity.verification_notes,
      ${config.ownerFields}
    FROM ${config.table} entity
    ${config.ownerJoin}
    WHERE entity.${config.idColumn} = ${castIdSql(entityType, "$1")}
    LIMIT 1
    `,
    [entityId]
  );

  return result.rows[0] ?? null;
};

const buildProfile = (
  entityType: VerificationEntityType,
  row: EntityRow
): VerificationEntityProfile => ({
  entityId: row.entity_id,
  entityType,
  entityName: row.entity_name,
  status: normalizeStatus(row.verification_status),
  submittedAt: row.submitted_at,
  verifiedAt: row.verified_at,
  verificationNotes: row.verification_notes,
});

const requireEntity = async (entityType: VerificationEntityType, entityId: string) => {
  const row = await getEntityRow(entityType, entityId);
  if (!row) {
    throw createStatusError("Verification entity not found", 404);
  }
  return row;
};

export const listVerificationEntities = async (options: {
  entityType?: string;
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}) => {
  const requestedType = options.entityType ? normalizeEntityType(options.entityType) : null;
  const requestedStatus = options.status ? normalizeStatus(options.status) : null;
  const normalizedSearch = String(options.search || "").trim().toLowerCase();
  const page = Number.isInteger(options.page) && Number(options.page) > 0 ? Number(options.page) : 1;
  const pageSize =
    Number.isInteger(options.pageSize) && Number(options.pageSize) > 0
      ? Math.min(Number(options.pageSize), 100)
      : 20;
  const entityTypes: VerificationEntityType[] = requestedType
    ? [requestedType]
    : ["clinic", "doctor", "pharmacy"];

  const itemGroups = await Promise.all(
    entityTypes.map(async (entityType) => {
      const config = getEntityConfig(entityType);
      const rows = await pool.query<
        EntityRow & {
          document_count: number;
          last_review_id: string | null;
          last_review_status: string | null;
          last_review_note: string | null;
          last_reviewed_at: string | null;
          reviewer_id: number | null;
          reviewer_name: string | null;
          reviewer_email: string | null;
        }
      >(
        `
        SELECT
          entity.${config.idColumn}::text AS entity_id,
          ${config.nameColumn} AS entity_name,
          LOWER(COALESCE(entity.verification_status, 'pending')) AS verification_status,
          entity.created_at::text AS submitted_at,
          entity.verified_at::text AS verified_at,
          entity.verification_notes,
          ${config.ownerFields},
          COALESCE(document_stats.document_count, 0) AS document_count,
          latest_review.id AS last_review_id,
          LOWER(latest_review.status) AS last_review_status,
          latest_review.note AS last_review_note,
          latest_review.reviewed_at::text AS last_reviewed_at,
          reviewer.id AS reviewer_id,
          reviewer.name AS reviewer_name,
          reviewer.email AS reviewer_email
        FROM ${config.table} entity
        ${config.ownerJoin}
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS document_count
          FROM verification_documents vd
          WHERE LOWER(vd.entity_type) = $1
            AND vd.entity_id = entity.${config.idColumn}::text
        ) document_stats ON TRUE
        LEFT JOIN LATERAL (
          SELECT id, status, note, reviewed_at, reviewed_by
          FROM verification_reviews
          WHERE LOWER(entity_type) = $1
            AND entity_id = entity.${config.idColumn}::text
          ORDER BY reviewed_at DESC
          LIMIT 1
        ) latest_review ON TRUE
        LEFT JOIN users reviewer ON reviewer.id = latest_review.reviewed_by
        ${requestedStatus ? "WHERE LOWER(COALESCE(entity.verification_status, 'pending')) = $2" : ""}
        ORDER BY entity.created_at DESC
        `,
        requestedStatus ? [entityType, requestedStatus] : [entityType]
      );

      return rows.rows.map<VerificationListItem>((row) => ({
        entityId: row.entity_id,
        entityName: row.entity_name,
        entityType,
        submittedAt: row.submitted_at,
        status: normalizeStatus(row.verification_status),
        documentCount: Number(row.document_count || 0),
        owner:
          row.owner_id !== null
            ? {
                id: row.owner_id,
                name: row.owner_name || "Unknown",
                email: row.owner_email,
                role: row.owner_role,
              }
            : null,
        assignedReviewer: null,
        lastAction: row.last_review_id
          ? {
              id: row.last_review_id,
              status: normalizeStatus(row.last_review_status || "pending"),
              note: row.last_review_note,
              reviewedAt: row.last_reviewed_at || row.submitted_at || new Date(0).toISOString(),
              reviewedBy:
                row.reviewer_id !== null
                  ? {
                      id: row.reviewer_id,
                      name: row.reviewer_name || "Admin",
                      email: row.reviewer_email,
                    }
                  : null,
            }
          : null,
      }));
    })
  );

  const filteredItems = itemGroups
    .flat()
    .filter((item) => {
      if (!normalizedSearch) {
        return true;
      }

      const haystack = [
        item.entityName,
        item.owner?.name || "",
        item.owner?.email || "",
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    })
    .sort((left, right) => {
      const leftTime = left.submittedAt ? new Date(left.submittedAt).getTime() : 0;
      const rightTime = right.submittedAt ? new Date(right.submittedAt).getTime() : 0;
      return rightTime - leftTime;
    });
  const total = filteredItems.length;
  const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
  const offset = (page - 1) * pageSize;
  const paginatedItems = filteredItems.slice(offset, offset + pageSize);

  return {
    items: paginatedItems,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
    },
  };
};

export const getVerificationEntityDetail = async (entityTypeInput: string, entityId: string) => {
  const entityType = normalizeEntityType(entityTypeInput);
  const row = await requireEntity(entityType, entityId);
  const config = getEntityConfig(entityType);

  const [metadataResult, documentsResult, reviewsResult] = await Promise.all([
    pool.query<Record<string, unknown>>(config.metadataSql, [entityId]),
    pool.query<{
      id: string;
      document_type: string;
      file_url: string;
      uploaded_at: string;
    }>(
      `
      SELECT id, document_type, file_url, uploaded_at::text AS uploaded_at
      FROM verification_documents
      WHERE LOWER(entity_type) = $1
        AND entity_id = $2
      ORDER BY uploaded_at DESC
      `,
      [entityType, entityId]
    ),
    pool.query<{
      id: string;
      status: string;
      note: string | null;
      reviewed_at: string;
      reviewer_id: number | null;
      reviewer_name: string | null;
      reviewer_email: string | null;
    }>(
      `
      SELECT
        vr.id,
        LOWER(vr.status) AS status,
        vr.note,
        vr.reviewed_at::text AS reviewed_at,
        reviewer.id AS reviewer_id,
        reviewer.name AS reviewer_name,
        reviewer.email AS reviewer_email
      FROM verification_reviews vr
      LEFT JOIN users reviewer ON reviewer.id = vr.reviewed_by
      WHERE LOWER(vr.entity_type) = $1
        AND vr.entity_id = $2
      ORDER BY vr.reviewed_at DESC
      `,
      [entityType, entityId]
    ),
  ]);

  const metadataRow = metadataResult.rows[0] ?? {};
  const metadata = Object.entries(metadataRow)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
    .map(([label, value]) => ({
      label,
      value: String(value),
    }));

  const reviewHistory = reviewsResult.rows.map((review) => ({
    id: review.id,
    status: normalizeStatus(review.status),
    note: review.note,
    reviewedAt: review.reviewed_at,
    reviewedBy:
      review.reviewer_id !== null
        ? {
            id: review.reviewer_id,
            name: review.reviewer_name || "Admin",
            email: review.reviewer_email,
          }
        : null,
  }));

  return {
    profile: buildProfile(entityType, row),
    linkedAccount:
      row.owner_id !== null
        ? {
            id: row.owner_id,
            name: row.owner_name || "Unknown",
            email: row.owner_email,
            role: row.owner_role,
          }
        : null,
    metadata,
    documents: documentsResult.rows.map((doc) => ({
      id: doc.id,
      documentType: doc.document_type,
      fileUrl: doc.file_url,
      uploadedAt: doc.uploaded_at,
    })),
    reviewHistory,
    statusHistory: reviewHistory,
    currentReviewer: reviewHistory[0]?.reviewedBy ?? null,
  };
};

const validateEntityBeforeApproval = async (entityType: VerificationEntityType, entityId: string) => {
  await requireEntity(entityType, entityId);

  const documentsResult = await pool.query<{ count: number }>(
    `
    SELECT COUNT(*)::int AS count
    FROM verification_documents
    WHERE LOWER(entity_type) = $1
      AND entity_id = $2
    `,
    [entityType, entityId]
  );

  if ((documentsResult.rows[0]?.count ?? 0) <= 0) {
    throw createStatusError("Cannot approve without submitted verification documents", 400);
  }
};

export const reviewVerificationEntity = async (options: {
  entityType: string;
  entityId: string;
  status: VerificationStatus;
  note?: string | null;
  reviewedByUserId: number;
}) => {
  const entityType = normalizeEntityType(options.entityType);
  const status = normalizeStatus(options.status);
  await requireEntity(entityType, options.entityId);

  if (status === "approved") {
    await validateEntityBeforeApproval(entityType, options.entityId);
  }

  const config = getEntityConfig(entityType);
  const idSql = castIdSql(entityType, "$4");
  const verifiedAt = status === "approved" ? "NOW()" : "NULL";
  const verifiedBy = status === "approved" ? "$2" : "NULL";

  await pool.query(
    `
    UPDATE ${config.table}
    SET
      verification_status = $1,
      verified_at = ${verifiedAt},
      verified_by = ${verifiedBy},
      verification_notes = $3
    WHERE ${config.idColumn} = ${idSql}
    `,
    [status, options.reviewedByUserId, options.note ?? null, options.entityId]
  );

  if (entityType === "clinic") {
    const operationalStatus =
      status === "approved" ? "ACTIVE" : status === "suspended" ? "SUSPENDED" : "INACTIVE";

    await pool.query(
      `
      UPDATE medical_centers
      SET status = $1
      WHERE id = $2::uuid
      `,
      [operationalStatus, options.entityId]
    );
  } else if (entityType === "pharmacy") {
    const operationalStatus =
      status === "approved" ? "ACTIVE" : status === "suspended" ? "SUSPENDED" : "INACTIVE";

    await pool.query(
      `
      UPDATE pharmacies
      SET status = $1
      WHERE id = $2::int
      `,
      [operationalStatus, options.entityId]
    );
  }

  await pool.query(
    `
    INSERT INTO verification_reviews (
      entity_type,
      entity_id,
      status,
      note,
      reviewed_by
    )
    VALUES ($1, $2, $3, $4, $5)
    `,
    [entityType, options.entityId, status, options.note ?? null, options.reviewedByUserId]
  );

  await pool.query(
    `
    INSERT INTO audit_logs (
      actor_id,
      actor_user_id,
      actor_role,
      user_id,
      action,
      entity_type,
      entity_id,
      notes,
      metadata
    )
    VALUES ($1, $1, 'admin', $1, $2, $3, $4, $5::jsonb, $5::jsonb)
    `,
    [
      options.reviewedByUserId,
      status === "suspended"
        ? "verification_suspended"
        : status === "approved"
          ? "verification_approved"
          : "verification_rejected",
      entityType,
      options.entityId,
      JSON.stringify({
        note: options.note ?? null,
        verification_status: status,
      }),
    ]
  );

  return getVerificationEntityDetail(entityType, options.entityId);
};

export const addVerificationEntityNote = async (options: {
  entityType: string;
  entityId: string;
  note: string;
  reviewedByUserId: number;
}) => {
  const entityType = normalizeEntityType(options.entityType);
  const entity = await requireEntity(entityType, options.entityId);
  const note = String(options.note || "").trim();

  if (!note) {
    throw createStatusError("A verification note is required", 400);
  }

  await pool.query(
    `
    INSERT INTO verification_reviews (
      entity_type,
      entity_id,
      status,
      note,
      reviewed_by
    )
    VALUES ($1, $2, $3, $4, $5)
    `,
    [entityType, options.entityId, entity.verification_status, note, options.reviewedByUserId]
  );

  await pool.query(
    `
    INSERT INTO audit_logs (
      actor_id,
      actor_user_id,
      actor_role,
      user_id,
      action,
      entity_type,
      entity_id,
      notes,
      metadata
    )
    VALUES ($1, $1, 'admin', $1, 'verification_note_added', $2, $3, $4::jsonb, $4::jsonb)
    `,
    [
      options.reviewedByUserId,
      entityType,
      options.entityId,
      JSON.stringify({
        note,
        verification_status: entity.verification_status,
      }),
    ]
  );

  return getVerificationEntityDetail(entityType, options.entityId);
};

export const assertVerifiedClinic = async (clinicId: string) => {
  const result = await pool.query<{
    name: string | null;
    email: string | null;
    status: string | null;
    verification_status: string | null;
  }>(
    `
    SELECT
      name,
      email,
      LOWER(COALESCE(status, '')) AS status,
      LOWER(COALESCE(verification_status, 'pending')) AS verification_status
    FROM medical_centers
    WHERE id = $1::uuid
    LIMIT 1
    `,
    [clinicId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Medical center not found", 404);
  }

  const clinic = result.rows[0];
  const resolvedApprovalStatus = resolveClinicApprovalStatus(clinic);
  const isOperationallyActive = isClinicOperationallyActive(clinic.status);

  if (resolvedApprovalStatus !== "approved" || !isOperationallyActive) {
    const error = createStatusError("Medical center is not approved for bookings", 403) as HttpError & {
      debug?: Record<string, unknown>;
    };
    error.debug = {
      clinicId,
      centerName: clinic.name,
      centerEmail: clinic.email,
      status: clinic.status,
      verification_status: clinic.verification_status,
      resolvedApprovalStatus,
      isOperationallyActive,
      legacyStatusFallbackUsed:
        clinic.verification_status === "pending" && clinic.status === "approved",
      detail: buildApprovalStatusMessage("Medical center", resolvedApprovalStatus),
    };
    throw error;
  }
};

export const assertVerifiedDoctorByProfileId = async (doctorId: number) => {
  const result = await pool.query<{
    verification_status: string;
    medical_center_id: string | null;
  }>(
    `
    SELECT
      LOWER(COALESCE(verification_status, 'pending')) AS verification_status,
      medical_center_id
    FROM doctors
    WHERE id = $1
    LIMIT 1
    `,
    [doctorId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Doctor not found", 404);
  }

  if (result.rows[0].verification_status !== "approved") {
    throw createStatusError(
      buildApprovalStatusMessage("Doctor", result.rows[0].verification_status),
      403
    );
  }

  if (result.rows[0].medical_center_id) {
    await assertVerifiedClinic(result.rows[0].medical_center_id);
  }
};

export const assertVerifiedDoctorProfileOnly = async (doctorId: number) => {
  const result = await pool.query<{
    verification_status: string;
  }>(
    `
    SELECT LOWER(COALESCE(verification_status, 'pending')) AS verification_status
    FROM doctors
    WHERE id = $1
    LIMIT 1
    `,
    [doctorId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Doctor not found", 404);
  }

  if (result.rows[0].verification_status !== "approved") {
    throw createStatusError(
      buildApprovalStatusMessage("Doctor", result.rows[0].verification_status),
      403
    );
  }
};

export const assertVerifiedDoctorByUserId = async (userId: number) => {
  const result = await pool.query<{ id: number }>(
    `
    SELECT id
    FROM doctors
    WHERE user_id = $1
    LIMIT 1
    `,
    [userId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("Doctor profile not found", 404);
  }

  await assertVerifiedDoctorByProfileId(result.rows[0].id);
};

export const assertVerifiedPharmacyForUser = async (userId: number) => {
  const result = await pool.query<{ verification_status: string }>(
    `
    SELECT LOWER(COALESCE(p.verification_status, 'pending')) AS verification_status
    FROM pharmacist_pharmacies pp
    JOIN pharmacies p ON p.id = pp.pharmacy_id
    WHERE pp.user_id = $1
    ORDER BY pp.created_at ASC
    LIMIT 1
    `,
    [userId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("No pharmacy is linked to this pharmacist", 403);
  }

  if (result.rows[0].verification_status !== "approved") {
    throw createStatusError(
      buildApprovalStatusMessage("Pharmacy", result.rows[0].verification_status),
      403
    );
  }
};

export const assertApprovedMedicalCenterForUser = async (userId: number) => {
  const result = await pool.query<{ verification_status: string }>(
    `
    SELECT LOWER(COALESCE(mc.verification_status, 'pending')) AS verification_status
    FROM medical_center_users mcu
    JOIN medical_centers mc ON mc.id = mcu.medical_center_id
    WHERE mcu.user_id = $1
      AND mcu.status = 'ACTIVE'
    ORDER BY mcu.joined_at ASC
    LIMIT 1
    `,
    [userId]
  );

  if (result.rows.length === 0) {
    throw createStatusError("No approved medical center is linked to this account", 403);
  }

  if (result.rows[0].verification_status !== "approved") {
    throw createStatusError(
      buildApprovalStatusMessage("Medical center", result.rows[0].verification_status),
      403
    );
  }
};
