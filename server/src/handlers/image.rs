use std::io::Cursor;

use image::GenericImageView;
use image::{codecs::avif::AvifEncoder, ImageReader};

use crate::errors::AtomicServerResult;

use super::download::DownloadParams;

/// Returns true if `bytes` decodes as an image with positive dimensions.
pub fn is_image_bytes(bytes: &[u8]) -> bool {
    matches!(
        image::load_from_memory(bytes),
        Ok(img) if img.dimensions() > (0, 0)
    )
}

/// Decode `bytes`, optionally resize to the requested width, and re-encode in
/// `format` (`webp` or `avif`). Returns the encoded bytes — no filesystem.
pub fn process_image_bytes(
    bytes: &[u8],
    params: &DownloadParams,
    format: &str,
) -> AtomicServerResult<Vec<u8>> {
    let quality = params.q.unwrap_or(100.0).clamp(0.0, 100.0);

    let mut img = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()?
        .decode()
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    if let Some(width) = &params.w {
        if *width < img.dimensions().0 {
            img = img.resize(*width, 10000, image::imageops::FilterType::Lanczos3);
        }
    }

    match format {
        "webp" => {
            let encoder = webp::Encoder::from_image(&img)?;
            let q = params.q.unwrap_or(75.0);
            // `WebPMemory` derefs to `&[u8]`; copy into an owned Vec so the
            // caller doesn't need to juggle the wrapper's lifetime.
            Ok(encoder.encode(q).to_vec())
        }
        "avif" => {
            let mut out = Vec::new();
            let encoder = AvifEncoder::new_with_speed_quality(&mut out, 8, quality as u8);
            img.write_with_encoder(encoder)
                .map_err(|e| format!("Failed to encode image: {}", e))?;
            Ok(out)
        }
        _ => Err(format!("Unsupported format: {}", format).into()),
    }
}
