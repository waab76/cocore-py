"use client";

import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";
import { createLink } from "@tanstack/react-router";

import { highlightCodeQueryOptions } from "@/components/account/account.functions.ts";
import { CreateApiKeyButton } from "@/components/api-keys/CreateApiKeyButton.tsx";
import { Button } from "@/design-system/button";
import { getSessionQueryOptions } from "@/integrations/auth/session.functions.ts";
import { fontFamily, fontSize, lineHeight } from "@/design-system/theme/typography.stylex";
import { uiColor } from "@/design-system/theme/color.stylex";
import { spacing } from "@/design-system/theme/spacing.stylex";
import { verticalSpace } from "@/design-system/theme/semantic-spacing.stylex";

export const inferenceDocsSharedStyles = stylex.create({
  highlightedSnippet: {
    borderColor: uiColor.border1,
    borderRadius: "0.5rem",
    borderStyle: "solid",
    borderWidth: 1,
    marginBottom: verticalSpace["2xl"],
    marginTop: verticalSpace["2xl"],
    overflow: "hidden",
  },
  usage: {
    background: "rgba(0,0,0,0.05)",
    borderColor: uiColor.component3,
    borderRadius: "0.5rem",
    borderStyle: "solid",
    borderWidth: 1,
    fontFamily: fontFamily.mono,
    fontSize: "0.8125rem",
    marginBottom: verticalSpace["2xl"],
    marginTop: verticalSpace["2xl"],
    overflowX: "auto",
    padding: "1rem 1.25rem",
    whiteSpace: "pre",
  },
  list: {
    color: uiColor.solid2,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.base,
    lineHeight: lineHeight.base,
    listStylePosition: "outside",
    margin: "0.5rem 0 0",
    paddingLeft: spacing["10"],
  },
  bullet: {
    marginBottom: spacing["2"],
    paddingLeft: spacing["1"],
  },
  nextLinks: {
    display: "flex",
    flexDirection: "column",
    gap: verticalSpace.md,
    marginTop: verticalSpace["3xl"],
  },
});

const ButtonLink = createLink(Button);

export function HighlightedBlock({ code, lang }: { code: string; lang: "json" | "bash" }) {
  const { data } = useQuery(highlightCodeQueryOptions({ code, lang }));
  if (data) {
    return (
      <div
        {...stylex.props(inferenceDocsSharedStyles.highlightedSnippet)}
        dangerouslySetInnerHTML={{ __html: data }}
      />
    );
  }
  return <pre {...stylex.props(inferenceDocsSharedStyles.usage)}>{code}</pre>;
}

export function CreateApiKeyOrLoginButton({ redirectTo }: { redirectTo: string }) {
  const { data: session, isPending } = useQuery(getSessionQueryOptions);

  if (isPending) {
    return (
      <Button size="sm" variant="primary" isDisabled isPending>
        Create API key
      </Button>
    );
  }

  if (session?.user) {
    return <CreateApiKeyButton size="sm" label="Create API key" />;
  }

  return (
    <ButtonLink to="/login" search={{ redirect: redirectTo }} variant="primary" size="sm">
      Log in to create a key
    </ButtonLink>
  );
}
