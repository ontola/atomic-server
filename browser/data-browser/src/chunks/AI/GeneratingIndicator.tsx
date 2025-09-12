import styled from 'styled-components';
import { Row } from '@components/Row';

interface GeneratingIndicatorProps {
  text: string;
}

export function GeneratingIndicator({ text }: GeneratingIndicatorProps) {
  return (
    <Wrapper center gap='1ch'>
      <svg height='1em' width='2.5em' viewBox='0 0 25 10'>
        <style>
          {`
            @keyframes bounce {
              0%, 100% {
                transform: translateY(2px);
              }
              50% {
                transform: translateY(-2px);
              }
            }
            .dot {
              fill: currentColor;
              animation: bounce 1s infinite ease-in-out;
            }
            .dot1 {
              animation-delay: 0ms;
            }
            .dot2 {
              animation-delay: 200ms;
            }
            .dot3 {
              animation-delay: 400ms;
            }
          `}
        </style>
        <circle cx='5' cy='5' r='2' className='dot dot1' />
        <circle cx='12.5' cy='5' r='2' className='dot dot2' />
        <circle cx='20' cy='5' r='2' className='dot dot3' />
      </svg>
      <span>{text}</span>
    </Wrapper>
  );
}

const Wrapper = styled(Row)`
  font-size: 12px;
  color: ${p => p.theme.colors.textLight};
`;
