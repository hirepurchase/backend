import { supabase, STORAGE_BUCKET } from '../config/supabase';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

export interface UploadResult {
  success: boolean;
  publicUrl?: string;
  error?: string;
}

/**
 * Upload a file to Supabase Storage
 * @param file - File buffer or path
 * @param folder - Folder name in bucket (e.g., 'customers', 'signatures')
 * @param originalFilename - Original filename
 * @returns Upload result with public URL
 */
export async function uploadToSupabase(
  fileBuffer: Buffer,
  folder: string,
  originalFilename: string
): Promise<UploadResult> {
  try {
    // Check if Supabase is configured
    if (!supabase) {
      return {
        success: false,
        error: 'Supabase storage not configured. File upload to cloud storage is unavailable.'
      };
    }

    // Generate unique filename
    const fileExt = path.extname(originalFilename);
    const fileName = `${uuidv4()}${fileExt}`;
    const filePath = `${folder}/${fileName}`;

    // Upload file to Supabase
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(filePath, fileBuffer, {
        contentType: getContentType(fileExt),
        cacheControl: '3600',
        upsert: false
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return {
        success: false,
        error: error.message
      };
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(filePath);

    return {
      success: true,
      publicUrl: urlData.publicUrl
    };
  } catch (error: any) {
    console.error('Upload error:', error);
    return {
      success: false,
      error: error.message || 'Upload failed'
    };
  }
}

/**
 * Delete a file from Supabase Storage
 * @param fileUrl - Public URL of the file
 * @returns Success status
 */
export async function deleteFromSupabase(fileUrl: string): Promise<boolean> {
  try {
    // Check if Supabase is configured
    if (!supabase) {
      console.warn('Supabase storage not configured. Cannot delete file from cloud storage.');
      return false;
    }

    // Extract file path from URL
    const url = new URL(fileUrl);
    const pathParts = url.pathname.split(`/${STORAGE_BUCKET}/`);
    if (pathParts.length < 2) {
      console.error('Invalid file URL');
      return false;
    }

    const filePath = pathParts[1];

    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove([filePath]);

    if (error) {
      console.error('Supabase delete error:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Delete error:', error);
    return false;
  }
}

/**
 * Get content type based on file extension
 */
function getContentType(fileExt: string): string {
  const contentTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.svg': 'image/svg+xml'
  };

  return contentTypes[fileExt.toLowerCase()] || 'application/octet-stream';
}

export default {
  uploadToSupabase,
  deleteFromSupabase
};
