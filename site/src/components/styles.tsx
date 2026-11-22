import { styled } from "@linaria/react";
import { subtleUnderline } from "./link-styles";

export const CardBlock = styled.div`
  margin: 16px auto 0;
  padding: 16px 20px;
  background: var(--group);
  border: 1px solid var(--group-border);
  border-radius: 10px;
  box-shadow: var(--group-shadow);
  color: var(--text);
  font-size: 16px;
  line-height: 1.6;
`;

export const Dim = styled.span`
  color: var(--text-dim);
  font-weight: 400;
`;

/** The title and what follows it share the text baseline, not the box centers */
export const PageHeader = styled.div`
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin-bottom: 16px;
`;

export const PageTitle = styled.h1`
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.25;
  /* Long option names break anywhere, titles with spaces between words */
  overflow-wrap: anywhere;

  > svg {
    flex-shrink: 0;
    align-self: center;
  }
`;

export const Card = styled.section`
  margin-bottom: 16px;
  background: var(--group);
  border: 1px solid var(--group-border);
  border-radius: 10px;
  box-shadow: var(--group-shadow);
  display: flow-root;
  overflow: clip;
  overflow-wrap: anywhere;
`;

export const CardHeader = styled.header`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  padding: 12px 16px;
`;

export const CardTitle = styled.h2`
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  word-break: break-all;

  > svg {
    flex-shrink: 0;
  }
`;

/** Padded content of a card, under its header */
export const CardBody = styled.div`
  padding: 0 16px 14px;
`;

/** Inline list of links in a detail, wrapping */
export const InlineList = styled.span`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 18px;

  > span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    ${subtleUnderline}
    color: inherit;

    &:hover {
      color: var(--highlight);
    }
  }

  svg {
    flex-shrink: 0;
    border-radius: 3px;
  }
`;
