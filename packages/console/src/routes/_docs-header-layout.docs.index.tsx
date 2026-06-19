import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_docs-header-layout/docs/")({
  beforeLoad: () => {
    throw redirect({ to: "/docs/inference", replace: true });
  },
});
