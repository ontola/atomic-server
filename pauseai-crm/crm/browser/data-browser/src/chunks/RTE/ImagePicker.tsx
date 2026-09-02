import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from '@tiptap/react';
import { Image, type ImageOptions } from '@tiptap/extension-image';
import { styled } from 'styled-components';
import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { InputStyled, InputWrapper } from '../../components/forms/InputStyles';
import { Column, Row } from '../../components/Row';
import { FilePickerDialog } from '../../components/forms/FilePicker/FilePickerDialog';
import { useStore, type Server } from '@tomic/react';
import {
  ClearType,
  FilePickerButton,
} from '../../components/forms/FilePicker/FilePickerButton';
import { imageMimeTypes } from '../../helpers/filetypes';
import { useHTMLFormFieldValidation } from '../../helpers/useHTMLFormFieldValidation';
import { transition } from '../../helpers/transition';
import { BsTextIndentLeft, BsTextIndentRight, BsJustify } from 'react-icons/bs';
import { ButtonGroup, type ButtonGroupOption } from '@components/ButtonGroup';
import { FaLink } from 'react-icons/fa6';

interface ExtendedImageProps extends ImageOptions {
  uploadImage?: (file: File[]) => Promise<string[]>;
  markdownCompatible?: boolean;
}

export const ExtendedImage = Image.extend<ExtendedImageProps>({
  addOptions() {
    return {
      ...this.parent?.(),
      markdownCompatible: false,
    } as ExtendedImageProps;
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      caption: {
        default: '',
      },
      alt: {
        default: '',
      },
      float: {
        default: 'none',
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(MarkdownEditorImage);
  },
});

const MarkdownEditorImage = ({
  node,
  updateAttributes,
  selected,
  editor,
  extension,
  ref,
}: ReactNodeViewProps<HTMLDivElement | HTMLImageElement>) => {
  const store = useStore();

  const [showPicker, setShowPicker] = useState(false);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const [urlValue, setUrlValue] = useState<string>();
  const [selectedSubject, setSelectedSubject] = useState<string>();
  const [altText, setAltText] = useState<string>();
  const [caption, setCaption] = useState<string>();
  const [float, setFloat] = useState<string>('none');
  const [imageError, setImageError] = useState<boolean>(false);
  const [urlValid, urlRef] = useHTMLFormFieldValidation();

  const floatOptions: ButtonGroupOption[] = [
    {
      label: 'Left',
      icon: <BsTextIndentLeft size={20} />,
      value: 'left',
    },
    {
      label: 'Inline',
      icon: <BsJustify size={20} />,
      value: 'none',
    },
    {
      label: 'Right',
      icon: <BsTextIndentRight size={20} />,
      value: 'right',
    },
  ];

  const canSave = () => {
    if (selectedSubject) {
      return true;
    }

    return urlValid;
  };

  const save = async () => {
    if (selectedSubject) {
      const resource = await store.getResource<Server.File>(selectedSubject);
      updateAttributes({
        src: resource.props.downloadUrl,
        alt: altText,
        caption,
        float,
      });
    } else if (urlValue) {
      updateAttributes({ src: urlValue, alt: altText, caption, float });
    }

    editor.chain().focus().run();
  };

  const uploadAndSet = extension.options.uploadImage
    ? async (file: File) => {
        const subjects = await extension.options.uploadImage([file]);
        setSelectedSubject(subjects[0]);
      }
    : undefined;

  if (imageError) {
    return (
      <NodeViewWrapper>
        <ImageError selected={selected}>Failed to load image.</ImageError>
      </NodeViewWrapper>
    );
  }

  if (
    !extension.options.markdownCompatible &&
    node.attrs.src &&
    node.attrs.caption
  ) {
    return (
      <NodeViewWrapper>
        <StyledFigure>
          <StyledImage
            ref={ref as React.ForwardedRef<HTMLImageElement>}
            src={node.attrs.src}
            alt={node.attrs.alt}
            selected={selected}
            float={node.attrs.float}
            onError={() => setImageError(true)}
          />
          <figcaption>{node.attrs.caption}</figcaption>
        </StyledFigure>
      </NodeViewWrapper>
    );
  }

  if (node.attrs.src) {
    return (
      <NodeViewWrapper>
        <StyledImage
          ref={ref as React.ForwardedRef<HTMLImageElement>}
          src={node.attrs.src}
          alt={node.attrs.alt}
          selected={selected}
          float={node.attrs.float}
          onError={() => setImageError(true)}
        />
        <p>{node.attrs.caption}</p>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper>
      <Wrapper ref={ref} selected={selected}>
        <Column justify='flex-start'>
          <ColumnGrid>
            <Column>
              {!selectedSubject && (
                <>
                  <Label>
                    Choose an image
                    <Column>
                      <StyledInputWrapper hasPrefix>
                        <FaLink />
                        <InputStyled
                          autoFocus
                          ref={urlRef}
                          type='url'
                          required
                          placeholder='Enter a URL...'
                          value={urlValue}
                          onChange={e => setUrlValue(e.target.value)}
                        />
                      </StyledInputWrapper>
                    </Column>
                  </Label>
                  <span>Or</span>
                </>
              )}
              <FilePickerButton
                onButtonClick={() => setShowPicker(true)}
                subject={selectedSubject}
                onClear={clearType => {
                  if (clearType === ClearType.Subject) {
                    setSelectedSubject(undefined);
                  }
                }}
              />
            </Column>
            <Column>
              {!extension.options.markdownCompatible && (
                <Label>
                  Caption
                  <InputWrapper>
                    <InputStyled
                      placeholder='Add a caption...'
                      value={caption}
                      onChange={e => setCaption(e.target.value)}
                    />
                  </InputWrapper>
                </Label>
              )}
              <Label>
                Textual Description
                <TextArea
                  placeholder='Alt text'
                  value={altText}
                  onChange={e => setAltText(e.target.value)}
                />
              </Label>
              {!extension.options.markdownCompatible && (
                <Label>
                  Text Flow
                  <ButtonGroup
                    options={floatOptions}
                    value={float}
                    onChange={setFloat}
                    name='float'
                  />
                </Label>
              )}
            </Column>
          </ColumnGrid>
          <Row justify='flex-end'>
            <Button disabled={!canSave()} onClick={save} ref={saveButtonRef}>
              Save
            </Button>
          </Row>
        </Column>
      </Wrapper>
      <FilePickerDialog
        show={showPicker}
        onShowChange={state => {
          setShowPicker(state);

          if (!state) {
            saveButtonRef.current?.focus();
          }
        }}
        onResourcePicked={setSelectedSubject}
        onNewFilePicked={uploadAndSet}
        allowedMimes={imageMimeTypes}
      />
    </NodeViewWrapper>
  );
};

MarkdownEditorImage.displayName = 'MarkdownEditorImage';

type SelectableProps = {
  selected: boolean;
};

type ImageProps = SelectableProps & {
  float: string;
};

const StyledImage = styled.img<ImageProps>`
  max-width: 100%;
  height: auto;
  border-radius: ${p => p.theme.radius};
  margin-bottom: ${p => p.theme.size()};

  float: ${p => p.float};
  margin-left: ${p => (p.float === 'right' ? '1rem' : '0')};
  margin-right: ${p => (p.float === 'left' ? '1rem' : '0')};

  ${transition('box-shadow', 'filter')}

  .tiptap:focus-within & {
    box-shadow: 0 0 0 2px
      ${p => (p.selected ? p.theme.colors.main : 'transparent')};
    filter: ${p => (p.selected ? 'brightness(0.9)' : 'none')};
  }

  figure:has(&) {
    float: ${p => p.float};
    margin-left: ${p => (p.float === 'right' ? '1rem' : '0')};
    margin-right: ${p => (p.float === 'left' ? '1rem' : '0')};

    img {
      float: none;
      margin-left: 0;
      margin-right: 0;
    }
  }
`;

const Wrapper = styled.div<SelectableProps>`
  border: 2px dashed
    ${p => (p.selected ? p.theme.colors.main : p.theme.colors.bg2)};
  border-radius: ${p => p.theme.radius};
  padding: ${p => p.theme.size()};
  margin-bottom: ${p => p.theme.size()};
`;

const ColumnGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: ${p => p.theme.size()};
`;

const TextArea = styled.textarea`
  width: 100%;
  color: ${p => p.theme.colors.text};
  background-color: ${p => p.theme.colors.bg};
  padding: ${p => p.theme.margin / 2}rem;
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.bg2};
  font-size: 1rem;
  font-family: inherit;
  resize: vertical;
  min-height: 5rem;
  &:focus {
    border-color: ${p => p.theme.colors.main};
    outline-color: ${p => p.theme.colors.main};
  }
`;

const StyledInputWrapper = styled(InputWrapper)`
  flex: unset;
  &:has(:user-invalid) {
    border-color: ${p => p.theme.colors.alert} !important;
  }
`;

const ImageError = styled.div<SelectableProps>`
  background-color: ${p => p.theme.colors.bg1};
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
  color: ${p => p.theme.colors.textLight};
  width: 50%;
  aspect-ratio: 1/1;
  display: grid;
  place-items: center;
  font-size: 1.5rem;
  font-weight: 500;
  ${transition('box-shadow', 'filter')}

  .tiptap:focus-within & {
    box-shadow: 0 0 0 2px
      ${p => (p.selected ? p.theme.colors.main : 'transparent')};
    filter: ${p => (p.selected ? 'brightness(0.9)' : 'none')};
  }
`;

const StyledFigure = styled.figure`
  margin: 0;
  margin-bottom: ${p => p.theme.size()};
  ${StyledImage} {
    margin-bottom: 0;
  }

  figcaption {
    font-size: 0.875rem;
    color: ${p => p.theme.colors.textLight};
  }
`;

const Label = styled.label`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.875rem;
  font-weight: 600;

  input {
    font-size: 1rem;
  }
`;
