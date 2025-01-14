import { Resource } from '@tomic/lib';
import { Image } from '@/components/Image';
import styles from './ImageGalleryBlock.module.css';
import type { ImageGalleryBlock } from '@/ontologies/website';

const ImageGalleryBlock = async ({
  resource,
}: {
  resource: Resource<ImageGalleryBlock>;
}) => {
  return (
    <>
      {resource.props.name && <h2>{resource.props.name}</h2>}
      <div className={styles.imageGrid}>
        {resource.props.images?.map((image: string, index: number) => (
          <div key={index} className={styles.image}>
            <Image subject={image} alt='' />
          </div>
        ))}
      </div>
    </>
  );
};

export default ImageGalleryBlock;
