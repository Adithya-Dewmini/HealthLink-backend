import pool from "../config/db";

export const createAuditLog = async (input: {
  userId: number;
  action: string;
}) => {
  await pool.query(
    `
      INSERT INTO audit_logs (user_id, action)
      VALUES ($1, $2)
    `,
    [input.userId, input.action]
  );
};

export const createAuditLogWithClient = async (
  client: any,
  input: {
    userId: number;
    action: string;
  }
) => {
  await client.query(
    `
      INSERT INTO audit_logs (user_id, action)
      VALUES ($1, $2)
    `,
    [input.userId, input.action]
  );
};
