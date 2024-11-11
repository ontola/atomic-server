import React, { ReactNode } from 'react';
import styles from './Stack.module.css';
import clsx from 'clsx';

interface VStackProps {
  gap?: React.CSSProperties['gap'];
  align?: React.CSSProperties['alignItems'];
  justify?: React.CSSProperties['justifyContent'];
  height?: React.CSSProperties['height'];
  children: ReactNode;
}

const VStack = ({
  gap = '1rem',
  align = 'start',
  justify = 'start',
  height = 'auto',
  children,
}: VStackProps) => {
  const inlineStyles: Record<string, string | number> = {
    '--stack-gap': gap,
    '--stack-align': align,
    '--stack-justify': justify,
    '--stack-height': height,
  };

  return (
    <div style={inlineStyles} className={clsx([styles.stack, styles.vstack])}>
      {children}
    </div>
  );
};

export default VStack;
