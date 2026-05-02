import { v2 as cloudinary } from "cloudinary";
import { env } from "./env";

let configured = false;

const ensureCloudinaryConfigured = () => {
  if (configured) return;

  if (!env.cloudinaryName || !env.cloudinaryKey || !env.cloudinarySecret) {
    throw new Error("Cloudinary is not configured");
  }

  cloudinary.config({
    cloud_name: env.cloudinaryName,
    api_key: env.cloudinaryKey,
    api_secret: env.cloudinarySecret,
  });

  configured = true;
};

export const getCloudinary = () => {
  ensureCloudinaryConfigured();
  return cloudinary;
};

export default cloudinary;
