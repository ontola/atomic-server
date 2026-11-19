declare module '*.module.css' {
  const styles: Record<string, string>;

  export default styles;
}

declare module '*.css';

declare module '*.mjs?raw' {
  const source: string;

  export default source;
}
