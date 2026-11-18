import React, { useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { api, resolveApiUrl } from '../../lib/api.ts';

export function ImageAttachmentField({
  imageUrl,
  onChange,
  onError,
  label = 'Attach Image (Optional — post text, image, or both)',
}: {
  imageUrl: string | null;
  onChange: (url: string | null) => void;
  onError?: (message: string) => void;
  label?: string;
}) {
  const [uploading, setUploading] = useState(false);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const res = await api.upload<{ image_url: string }>('/api/media/upload', fd);
      onChange(res.image_url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Image upload failed.';
      if (onError) onError(msg);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{label}</span>
        <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800">
          <ImagePlus className="w-3.5 h-3.5" />
          {uploading ? 'Uploading...' : imageUrl ? 'Replace Image' : 'Add Image'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            disabled={uploading}
            onChange={(e) => void handleFileSelect(e)}
            className="hidden"
          />
        </label>
      </div>

      {imageUrl && (
        <div className="relative inline-block rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-50 dark:bg-slate-950">
          <img
            src={resolveApiUrl(imageUrl)}
            alt="Uploaded attachment preview"
            className="max-h-52 w-auto object-contain"
          />
          <button
            type="button"
            onClick={() => onChange(null)}
            className="absolute top-1.5 right-1.5 p-1 rounded-md bg-slate-900/80 text-white hover:bg-slate-900"
            aria-label="Remove attached image"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
