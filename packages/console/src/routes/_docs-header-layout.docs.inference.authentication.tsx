import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_docs-header-layout/docs/inference/authentication")({
  beforeLoad: () => {
    throw redirect({ to: "/docs/inference/$slug", params: { slug: "quickstart" }, replace: true });
  },
});
