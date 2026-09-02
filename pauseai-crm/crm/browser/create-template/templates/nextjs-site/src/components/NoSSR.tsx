import dynamic from 'next/dynamic';

const NoSSR = ({ children }: { children: React.ReactNode }) => {
  return <>{children}</>;
};

export default dynamic(() => Promise.resolve(NoSSR), {
  ssr: false,
});
