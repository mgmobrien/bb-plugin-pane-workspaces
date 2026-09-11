/** Decorate only the project heading; bb owns its sticky shields and children. */
export function decorateActiveHeading(container: HTMLElement): () => void {
  const heading = container.closest<HTMLElement>('[data-sidebar-sticky-tier="label"]');
  if (!heading) return () => {};
  heading.setAttribute("data-workspace-active", "");
  return () => {
    heading.removeAttribute("data-workspace-active");
  };
}
