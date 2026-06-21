import * as stylex from "@stylexjs/stylex";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronRight, InfoIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link as AriaLink } from "react-aria-components";
import { z } from "zod";

import {
  atprotoAuthorizeMutationOptions,
  atprotoAuthorizeServerFn,
  atprotoSignupMutationOptions,
  getSavedHandlesQueryOptions,
} from "@/integrations/auth/api-auth.functions.ts";
import { Button } from "@/design-system/button";
import { Avatar } from "@/design-system/avatar";
import { UserHandleAutocomplete } from "@/components/UserHandleAutocomplete.tsx";
import { Dialog, DialogBody, DialogDescription, DialogHeader } from "@/design-system/dialog";
import { Flex } from "@/design-system/flex";
import { Form } from "@/design-system/form";
import { IconButton } from "@/design-system/icon-button";
import { Separator } from "@/design-system/separator";
import { primaryColor, uiColor } from "@/design-system/theme/color.stylex";
import { breakpoints } from "@/design-system/theme/media-queries.stylex";
import { radius } from "@/design-system/theme/radius.stylex";
import { primary } from "@/design-system/theme/semantic-color.stylex";
import { fontSize } from "@/design-system/theme/typography.stylex";
import {
  gap as gapSpace,
  size as sizeSpace,
  verticalSpace,
} from "@/design-system/theme/semantic-spacing.stylex";
import { Body, Heading1, Heading4, InlineCode } from "@/design-system/typography";
import { unauthMiddleware } from "@/middleware/auth.ts";
import { Text } from "@/design-system/typography/text";
import { type SavedHandle, saveHandle } from "@/utils/saved-handles.ts";

const searchSchema = z.object({
  redirect: z.string().optional(),
  error: z.string().optional(),
  // Set by the OAuth callback so the browser can persist the handle
  // for next time. Optional — present only on the first hop after a
  // successful sign-in that *happens to* land on /login.
  loginSuccess: z.union([z.string(), z.boolean()]).optional(),
  handle: z.string().optional(),
  avatar: z.string().optional(),
});

const styles = stylex.create({
  dialogDescription: {
    paddingTop: verticalSpace["3xl"],
    paddingBottom: verticalSpace["3xl"],
  },
  buttonContainer: {
    width: "100%",
  },
  main: {
    backgroundColor: primaryColor.bgSubtle,
    display: "flex",
    flexDirection: "column",
    position: "relative",
    height: "100%",
  },
  container: {
    boxSizing: "border-box",
    padding: sizeSpace["4xl"],
    justifyContent: "center",
    alignItems: "center",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    height: "100%",
  },
  content: {
    padding: sizeSpace["3xl"],
    gap: gapSpace["5xl"],
    alignItems: "center",
    display: "flex",
    flexDirection: "column",
  },
  form: {
    width: {
      default: "100%",
      [breakpoints.sm]: "min(80vw, 420px)",
    },
  },
  savedHandlesContainer: {
    width: {
      default: "100%",
      [breakpoints.sm]: "min(80vw, 420px)",
    },
  },
  savedHandleButton: {
    paddingTop: verticalSpace.lg,
    paddingBottom: verticalSpace.lg,
    paddingLeft: sizeSpace.sm,
    paddingRight: sizeSpace.sm,
    borderRadius: radius["lg"],
    cornerShape: "squircle",
    gap: gapSpace.xl,
    textDecoration: "none",
    alignItems: "center",
    boxSizing: "border-box",
    cursor: "pointer",
    display: "flex",
    flexDirection: "row",
    justifyContent: "flex-start",
    textAlign: "left",
    width: "100%",
    outline: {
      default: "none",
      ":is([data-focus-visible='true'])": `2px solid ${primaryColor.solid1}`,
    },
    outlineOffset: 2,
  },
  savedHandleText: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  savedHandleIcon: {
    color: uiColor.text1,
    flexShrink: 0,
  },
  logoContainer: {
    paddingBottom: verticalSpace["lg"],
  },
  logoText: {
    color: primaryColor.textContrast,
    cornerRadius: "squircle",
    fontSize: fontSize.xs,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  logoMark: {
    display: "block",
    width: "2rem",
    height: "2rem",
  },
});

interface SavedHandleEntry extends SavedHandle {
  authorizationUrl: string;
}

export const Route = createFileRoute("/login")({
  validateSearch: searchSchema,
  server: {
    middleware: [unauthMiddleware],
  },
  loader: async ({ context, location }) => {
    const savedHandles = await context.queryClient.ensureQueryData(getSavedHandlesQueryOptions);

    // Pre-compute one authorize URL per saved handle so each card is
    // a direct anchor to the user's PDS — no extra hop through the
    // mutation. OAuth state is held in-memory with a 15-min TTL on
    // the server, which is plenty for the user to pick a card.
    const redirectParam = (location.search as Record<string, string>)["redirect"];
    const redirects = await Promise.all(
      savedHandles.map(async (saved): Promise<SavedHandleEntry> => {
        try {
          const { authorizationUrl } = await atprotoAuthorizeServerFn({
            data: {
              handle: saved.handle,
              redirect: redirectParam,
            },
          });
          return { ...saved, authorizationUrl };
        } catch {
          // If pre-computing fails for any reason (handle no longer
          // resolves, PDS down, …) we still want to render the card.
          // The fallback URL drops to the regular login mutation by
          // pointing at /login with the handle prefilled.
          return { ...saved, authorizationUrl: "" };
        }
      }),
    );
    return { savedHandles: redirects };
  },
  component: AuthPage,
  head: () => ({ meta: [{ title: "Sign in" }] }),
});

function AuthPage() {
  const {
    redirect: redirectTo,
    error,
    loginSuccess,
    handle: handleParam,
    avatar: avatarParam,
  } = Route.useSearch();
  const { savedHandles: initialSavedHandles } = Route.useLoaderData();
  const navigate = useNavigate();

  const [handle, setHandle] = useState("");
  const [savedHandles, setSavedHandles] = useState<Array<SavedHandleEntry>>(initialSavedHandles);
  const [view, setView] = useState<"saved-handles" | "login">(
    initialSavedHandles.length > 0 ? "saved-handles" : "login",
  );
  const [loginError, setLoginError] = useState<string | null>(null);

  // Edge case: user lands on /login with `loginSuccess=true` (e.g.
  // because their post-login redirect target was /login). Save the
  // handle and clean up the URL so the card appears next time.
  useEffect(() => {
    if ((loginSuccess === "true" || loginSuccess === true) && handleParam) {
      const avatar = avatarParam && avatarParam.trim() !== "" ? avatarParam : null;
      const updated = saveHandle(handleParam, avatar);
      setSavedHandles((prev) =>
        updated.map((u) => {
          const existing = prev.find((p) => p.handle === u.handle);
          return {
            ...u,
            authorizationUrl: existing?.authorizationUrl ?? "",
          };
        }),
      );
      void navigate({
        to: "/login",
        search: { redirect: redirectTo },
        replace: true,
      });
    }
  }, [loginSuccess, handleParam, avatarParam, navigate, redirectTo]);

  const loginMutation = useMutation({
    ...atprotoAuthorizeMutationOptions,
    onSuccess: (result) => {
      globalThis.location.assign(result.authorizationUrl);
    },
    onError: (err) => {
      setLoginError(err instanceof Error ? err.message : "Sign-in failed. Try again.");
    },
  });

  const signupMutation = useMutation({
    ...atprotoSignupMutationOptions,
    onSuccess: (result) => {
      globalThis.location.assign(result.authorizationUrl);
    },
    onError: (err) => {
      setLoginError(err instanceof Error ? err.message : "Sign-up failed. Try again.");
    },
  });

  return (
    <main {...stylex.props(styles.main)}>
      <div {...stylex.props(styles.container)}>
        <Form
          style={styles.content}
          onSubmit={(e) => {
            e.preventDefault();
            if (view !== "login") return;
            const trimmed = handle.trim().replace(/^@/, "");
            if (trimmed === "") {
              setLoginError("Enter your handle (for example name.bsky.social).");
              return;
            }
            if (loginMutation.isPending || signupMutation.isPending) return;
            setLoginError(null);
            loginMutation.mutate({ handle: trimmed, redirect: redirectTo });
          }}
        >
          <Flex direction="column" gap="5xl" style={styles.form}>
            <Flex align="center" justify="center" gap="3xl" style={styles.logoContainer}>
              <div {...stylex.props(styles.logoText)}>
                <img
                  src="/favicon.svg"
                  alt=""
                  width={40}
                  height={40}
                  {...stylex.props(styles.logoMark)}
                />
              </div>
              <Heading1>co/core</Heading1>
            </Flex>
            {error === "oauth_failed" || loginError ? (
              <Body variant="critical">
                {error === "oauth_failed" ? "Sign-in failed. Try again." : loginError}
              </Body>
            ) : null}

            {view === "saved-handles" && savedHandles.length > 0 ? (
              <Flex direction="column" gap="5xl" style={styles.savedHandlesContainer}>
                {savedHandles.map((saved) => (
                  <AriaLink
                    key={saved.handle}
                    href={
                      saved.authorizationUrl !== ""
                        ? saved.authorizationUrl
                        : `/login?handle=${encodeURIComponent(saved.handle)}`
                    }
                    aria-label={`Continue as ${saved.handle}`}
                    {...stylex.props(
                      styles.savedHandleButton,
                      primary.bgUi,
                      primary.borderInteractive,
                      primary.text,
                    )}
                  >
                    <Avatar
                      src={saved.avatar ?? undefined}
                      alt={saved.handle}
                      fallback={saved.handle[0]?.toUpperCase() ?? "?"}
                    />
                    <Text size="base" style={styles.savedHandleText} leading="base">
                      {saved.handle}
                    </Text>
                    <ChevronRight {...stylex.props(styles.savedHandleIcon)} />
                  </AriaLink>
                ))}
                <Separator />
              </Flex>
            ) : null}

            {view === "login" ? (
              <Flex direction="column" gap="md" align="stretch">
                <UserHandleAutocomplete
                  value={handle}
                  onValueChange={setHandle}
                  onSelect={(selectedHandle) => {
                    const trimmed = selectedHandle.trim().replace(/^@/, "");
                    if (trimmed === "") return;
                    setLoginError(null);
                    loginMutation.mutate({ handle: trimmed, redirect: redirectTo });
                  }}
                  label={
                    <Flex direction="row" gap="md" align="center" justify="between">
                      <Text size="base" weight="medium">
                        Atmosphere account
                      </Text>
                      <Dialog
                        trigger={
                          <IconButton
                            label="Info about handles and auth"
                            variant="tertiary"
                            size="sm"
                            onClick={(e) => e.preventDefault()}
                          >
                            <InfoIcon />
                          </IconButton>
                        }
                        size="md"
                      >
                        <DialogHeader>How login works</DialogHeader>
                        <DialogDescription style={styles.dialogDescription}>
                          Sign in with your AT Protocol account.
                        </DialogDescription>
                        <DialogBody>
                          <Flex direction="column" gap="6xl">
                            <Flex direction="column" gap="2xl">
                              <Heading4>What is a handle?</Heading4>
                              <Body variant="secondary">
                                A handle is your identifier on the ATmosphere network (for example{" "}
                                <InlineCode>user.bsky.social</InlineCode>
                                ).
                              </Body>
                            </Flex>

                            <Flex direction="column" gap="2xl">
                              <Heading4>Authentication</Heading4>
                              <Body variant="secondary">
                                You sign in with your Personal Data Server (PDS). This console does
                                not store your password—authorization happens with your PDS host.
                              </Body>
                            </Flex>

                            <Flex direction="column" gap="2xl">
                              <Heading4>Need an account?</Heading4>
                              <Body variant="secondary">
                                Use &quot;Create an account&quot; to sign up on a PDS host such as{" "}
                                <a
                                  href="https://selfhosted.social/"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  selfhosted.social
                                </a>
                                .
                              </Body>
                            </Flex>
                          </Flex>
                        </DialogBody>
                      </Dialog>
                    </Flex>
                  }
                  placeholder="name.bsky.social"
                  size="lg"
                />
              </Flex>
            ) : null}

            <Flex direction="column" gap="md" style={styles.buttonContainer}>
              {view === "saved-handles" ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  isDisabled={loginMutation.isPending || signupMutation.isPending}
                  onPress={() => setView("login")}
                >
                  Use a different account
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  isPending={loginMutation.isPending}
                  isDisabled={loginMutation.isPending || signupMutation.isPending}
                >
                  Log in
                </Button>
              )}
              <Button
                type="button"
                variant={view === "saved-handles" ? "tertiary" : "secondary"}
                size="lg"
                isPending={signupMutation.isPending}
                isDisabled={loginMutation.isPending || signupMutation.isPending}
                onPress={() => {
                  setLoginError(null);
                  signupMutation.mutate({ redirect: redirectTo });
                }}
              >
                Create an account
              </Button>
            </Flex>
          </Flex>
        </Form>
      </div>
    </main>
  );
}
