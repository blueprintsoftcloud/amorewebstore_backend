import "dotenv/config";
import { v2 as cloudinary } from "cloudinary";
import { env } from "./env";

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

/**
 * Inserts Cloudinary's automatic-format + automatic-quality transformation
 * (f_auto,q_auto — serves WebP/AVIF to browsers that support it, at Cloudinary's
 * chosen quality level) into a delivery URL. Cloudinary applies this transformation
 * at CDN delivery time regardless of when the asset was uploaded, so baking it into
 * the stored URL requires no re-encoding — see migrations/003_optimize_cloudinary_urls.ts
 * for the one-off pass that retrofits already-stored URLs.
 */
export const withAutoOptimization = (secureUrl: string): string =>
  secureUrl.includes("/upload/f_auto,q_auto/") ? secureUrl : secureUrl.replace("/upload/", "/upload/f_auto,q_auto/");

/**
 * Upload a file buffer to Cloudinary.
 * @param buffer - File buffer from multer memoryStorage
 * @param folder - Cloudinary folder path (e.g. "categories/cotton")
 * @returns Secure URL of the uploaded image, with f_auto,q_auto delivery optimization applied
 */
export async function uploadToCloudinary(
  buffer: Buffer,
  folder: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream({ folder, resource_type: "auto" }, (error, result) => {
        if (error || !result)
          return reject(error ?? new Error("Cloudinary upload failed"));
        resolve(withAutoOptimization(result.secure_url));
      })
      .end(buffer);
  });
}

/**
 * Delete an image from Cloudinary by its public URL or public_id.
 */
export async function deleteFromCloudinary(
  urlOrPublicId: string,
): Promise<void> {
  // Extract public_id from a full Cloudinary URL. The public_id is everything after
  // the version segment (v<digits>) — up to the file extension — and it can itself
  // contain slashes for nested upload folders (e.g. uploadToCloudinary's callers use
  // `products/${code}/gallery_${i}`, `company/favicon`, `company/og`, ...). Grabbing
  // just the last 2 path segments (the previous approach) silently computes the WRONG
  // id for anything nested more than one folder deep: cloudinary.uploader.destroy()
  // then reports "not found" for an id that never existed rather than throwing, so the
  // .catch() blocks at every call site never fire and the real asset is never deleted
  // — every gallery image, favicon, and OG image replaced or removed was leaking.
  let publicId = urlOrPublicId;
  if (urlOrPublicId.includes("cloudinary.com")) {
    const match = urlOrPublicId.match(/\/upload\/(?:[^/]+\/)?v\d+\/(.+)$/);
    publicId = match
      ? match[1].replace(/\.[^/.]+$/, "")
      : urlOrPublicId.split("/").slice(-2).join("/").replace(/\.[^/.]+$/, "");
  }

  await cloudinary.uploader.destroy(publicId);
}

export default cloudinary;
