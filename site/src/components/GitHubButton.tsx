import { styled } from "@linaria/react";
import { KindIcon } from "./kind-icon/KindIcon";

const GitHubLink = styled.a`
  display: inline-flex;
  /* The baseline comes from the label, like the rest of the page header */
  align-items: baseline;
  gap: 8px;
  margin-left: auto;
  color: var(--text-dim);
  text-decoration: none;

  &[data-button] {
    padding: 5px 12px;
    border-radius: 8px;
    border: 1px solid var(--group-border);
    background: var(--group);
    font-size: 14px;
    font-weight: 500;
    color: var(--text);
  }

  > svg {
    align-self: center;
  }

  &:hover {
    color: var(--highlight);
  }
`;

export function GitHubButton({
  href,
  title,
  label,
}: {
  href: string;
  title?: string;
  label?: string;
}) {
  return (
    <GitHubLink
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      data-button={label ? true : undefined}
    >
      <KindIcon kind="github" />
      {label}
    </GitHubLink>
  );
}
