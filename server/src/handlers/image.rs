use std::io::Write;
use std::path::PathBuf;

use image::GenericImageView;
use image::{codecs::avif::AvifEncoder, ImageReader};

use crate::errors::AtomicServerResult;

use super::download::DownloadParams;

pub fn is_image(file_path: &PathBuf) -> bool {
    if let Ok(img) = image::open(file_path) {
        return img.dimensions() > (0, 0);
    }
    false
}

pub fn process_image(
    file_path: &PathBuf,
    new_path: &PathBuf,
    params: &DownloadParams,
    format: &str,
) -> AtomicServerResult<()> {
    let quality = params.q.unwrap_or(100.0).clamp(0.0, 100.0);

    let mut img = ImageReader::open(file_path)?
        .with_guessed_format()?
        .decode()
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    if let Some(width) = &params.w {
        if *width < img.dimensions().0 {
            img = img.resize(*width, 10000, image::imageops::FilterType::Lanczos3);
        }
    }

    if format == "webp" {
        let encoder = webp::Encoder::from_image(&img)?;
        let webp_image = match params.q {
            Some(quality) => encoder.encode(quality),
            None => encoder.encode(75.0),
        };

        let mut file = std::fs::File::create(new_path)?;
        file.write_all(&webp_image)?;

        return Ok(());
    }

    if format == "avif" {
        let mut file = std::fs::File::create(new_path)?;
        let encoder = AvifEncoder::new_with_speed_quality(&mut file, 8, quality as u8);
        img.write_with_encoder(encoder)
            .map_err(|e| format!("Failed to encode image: {}", e))?;

        return Ok(());
    }

    Err(format!("Unsupported format: {}", format).into())
}
