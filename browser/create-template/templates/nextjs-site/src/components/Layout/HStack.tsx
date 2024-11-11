import React, { ReactNode } from 'react';
import clsx from 'clsx';
import styles from './Stack.module.css';

interface HStackProps {
  gap?: React.CSSProperties['gap'];
  align?: React.CSSProperties['alignItems'];
  justify?: React.CSSProperties['justifyContent'];
  fullWidth?: boolean;
  wrap?: boolean;
  children: ReactNode;
}

const HStack = ({
  gap = '1rem',
  align = 'start',
  justify = 'start',
  fullWidth = false,
  wrap = false,
  children,
}: HStackProps) => {
  const inlineStyles: Record<string, string | number> = {
    '--stack-gap': gap,
    '--stack-align': align,
    '--stack-justify': justify,
    '--stack-height': 'auto',
  };

  return (
    <div
      style={inlineStyles}
      className={clsx([styles.stack, styles.hStack], {
        [styles.fullWidth]: fullWidth,
        [styles.wrap]: wrap,
      })}
    >
      {children}
    </div>
  );
};

export default HStack;
