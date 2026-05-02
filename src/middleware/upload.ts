import multer from "multer";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const fileFilter: multer.Options["fileFilter"] = (_req, file, callback) => {
  if (!String(file.mimetype || "").toLowerCase().startsWith("image/")) {
    callback(new Error("Only images are allowed"));
    return;
  }

  callback(null, true);
};

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_SIZE_BYTES,
  },
  fileFilter,
});

export const IMAGE_UPLOAD_ERROR_MESSAGES = {
  tooLarge: "Image must be 5MB or smaller",
  invalidType: "Only images are allowed",
};
