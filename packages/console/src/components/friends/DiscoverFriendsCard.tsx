"use client";

// Discovery directory for the /friends page. Shows a paginated grid
// of every signed-up cocore account, sourced from the AppView's
// `dev.cocore.account.listAccounts` endpoint. Each card has avatar,
// display name, handle, joined-at, an optional "provider"
// badge, and a Friend / Friended button so the user can add someone
// without leaving the page.
//
// Filters live in a row above the grid:
//   * sort: recent activity vs. recently joined
//   * providers only: narrow to DIDs that own a provider record
//     (operators running agents) — useful when the user is shopping
//     for someone to trust with private compute, not just looking
//     to friend social connections.
//
// Pagination is offset-based via the design system's Pagination
// component. The query cache key includes the filter shape so flipping
// providersOnly or sort doesn't blow away the other filter's data.
//
// Adding a member opens a confirmation dialog on the parent
// `FriendsPage` before the PDS write runs.

import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import {
  discoverAccountsQueryOptions,
  FRIENDS_DISCOVER_PAGE_SIZE,
  listMyFriendsQueryOptions,
} from "@/components/friends/friends.functions.ts";
import type { AppviewAccountSummary } from "@/integrations/appview/appview.server.ts";
import { Avatar } from "@/design-system/avatar";
import { Badge } from "@/design-system/badge";
import { Button } from "@/design-system/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/design-system/card";
import { Checkbox } from "@/design-system/checkbox";
import { Flex } from "@/design-system/flex";
import { Pagination } from "@/design-system/pagination";
import { SegmentedControl, SegmentedControlItem } from "@/design-system/segmented-control";
import { successColor, uiColor } from "@/design-system/theme/color.stylex";
import { gap as gapSpace } from "@/design-system/theme/semantic-spacing.stylex";
import { fontFamily, fontSize, fontWeight } from "@/design-system/theme/typography.stylex";
import { SmallBody } from "@/design-system/typography";
import { Text } from "@/design-system/typography/text";

const styles = stylex.create({
  cardTitleMono: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.medium,
    color: uiColor.text2,
    textTransform: "lowercase",
  },
  filters: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: gapSpace["lg"],
    flexWrap: "wrap",
  },
  filterLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    color: uiColor.text2,
    textTransform: "uppercase",
    letterSpacing: "0.02em",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(20rem, 1fr))",
    gap: gapSpace["md"],
  },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: gapSpace["md"],
    padding: gapSpace["md"],
    border: `1px solid ${uiColor.border1}`,
    borderRadius: "0.5rem",
    backgroundColor: uiColor.component1,
  },
  /** Avatar + identity (flex) and provider/member badge (right). */
  cardUpper: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: gapSpace["sm"],
    minWidth: 0,
    width: "100%",
  },
  identityRowLink: {
    display: "flex",
    alignItems: "center",
    gap: gapSpace["lg"],
    color: "inherit",
    textDecoration: "none",
    flex: 1,
    minWidth: 0,
    ":hover": {
      textDecoration: "underline",
    },
  },
  identityText: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: gapSpace.lg,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    lineHeight: 1.25,
    color: uiColor.text2,
  },
  identityHandleLine: {
    opacity: 0.75,
    fontWeight: fontWeight.normal,
  },
  badgeSlot: {
    flexShrink: 0,
    alignSelf: "center",
  },
  cardDivider: {
    borderTopColor: uiColor.border1,
    borderTopStyle: "dashed",
    borderTopWidth: 1,
    alignSelf: "stretch",
  },
  /** Status (left) and + friend (right), one row under the divider. */
  cardLower: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: gapSpace["sm"],
    paddingLeft: gapSpace["md"],
    minHeight: "2rem",
  },
  statusLine: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: gapSpace["md"],
    minWidth: 0,
    flex: 1,
  },
  statusDot: {
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: "9999px",
    backgroundColor: successColor.solid1,
    flexShrink: 0,
    boxShadow: `0 0 0 2px ${successColor.bgSubtle}`,
  },
  statusText: {
    color: uiColor.text1,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.xs,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  friendButtonLabel: {
    fontFamily: fontFamily.mono,
    textTransform: "lowercase",
  },
  emptyState: {
    color: uiColor.text1,
    fontSize: fontSize.sm,
    paddingBlock: gapSpace["md"],
  },
  paginationRow: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "center",
    paddingTop: gapSpace["md"],
  },
});

/** Format a UTC ISO string as "joined 3d ago" / "active 2h ago" /
 *  "joined Apr 12". Coarse: hour resolution under a day, day
 *  resolution under a week, month resolution after. */
function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const now = Date.now();
  const seconds = Math.max(0, Math.floor((now - t) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(t));
}

export interface DiscoverFriendsCardProps {
  /** Invoked when the user chooses Friend; parent shows confirm + runs add. */
  onFriendIntent: (account: AppviewAccountSummary) => void;
}

export function DiscoverFriendsCard({ onFriendIntent }: DiscoverFriendsCardProps) {
  const [sortBy, setSortBy] = useState<"recent" | "newest">("recent");
  const [providersOnly, setProvidersOnly] = useState(false);
  const [page, setPage] = useState(1);

  // Reset to page 1 when filters change so the user isn't stranded on
  // page 6 of a now-narrower result set.
  const resetToPage1 = (): void => setPage(1);

  const filters = {
    sortBy,
    providersOnly,
    excludeViewerFriends: true,
    limit: FRIENDS_DISCOVER_PAGE_SIZE,
    offset: (page - 1) * FRIENDS_DISCOVER_PAGE_SIZE,
  };
  const directoryQuery = useQuery(discoverAccountsQueryOptions(filters));
  const friendsQuery = useQuery(listMyFriendsQueryOptions);
  const friendedDids = new Set((friendsQuery.data ?? []).map((f) => f.subject));

  const rawAccounts = directoryQuery.data?.accounts ?? [];
  // Belt-and-suspenders: never surface people already on the PDS friends list
  // (AppView index / discover cache can lag behind a fresh friend write).
  const accounts = rawAccounts.filter((a) => !friendedDids.has(a.did));
  const total = directoryQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / FRIENDS_DISCOVER_PAGE_SIZE));

  return (
    <Card size="md">
      <CardHeader hasBorder>
        <CardTitle style={styles.cardTitleMono}>Discover cocore members</CardTitle>
      </CardHeader>
      <CardBody>
        <Flex direction="column" gap="2xl">
          <div {...stylex.props(styles.filters)}>
            <Flex direction="row" align="center" gap="xl">
              <span {...stylex.props(styles.filterLabel)}>Sort</span>
              <SegmentedControl
                aria-label="Sort discover directory"
                size="sm"
                selectedKeys={new Set([sortBy])}
                onSelectionChange={(sel) => {
                  const id = sel.values().next().value;
                  if (id === "recent" || id === "newest") {
                    setSortBy(id);
                    resetToPage1();
                  }
                }}
              >
                <SegmentedControlItem id="recent">Recent activity</SegmentedControlItem>
                <SegmentedControlItem id="newest">Newest signup</SegmentedControlItem>
              </SegmentedControl>
            </Flex>
            <Checkbox
              isSelected={providersOnly}
              onChange={(v) => {
                setProvidersOnly(v);
                resetToPage1();
              }}
            >
              Providers only
            </Checkbox>
          </div>

          {directoryQuery.isLoading || friendsQuery.isPending ? (
            <SmallBody>Loading directory…</SmallBody>
          ) : directoryQuery.isError ? (
            <div {...stylex.props(styles.emptyState)}>
              Couldn't reach the AppView. Try again in a moment.
            </div>
          ) : rawAccounts.length === 0 ? (
            <div {...stylex.props(styles.emptyState)}>
              {providersOnly ? "No providers match this view yet." : "No accounts to show."}
            </div>
          ) : accounts.length === 0 ? (
            <div {...stylex.props(styles.emptyState)}>
              Everyone on this page is already in your friends list. Try another page if you have
              more results.
            </div>
          ) : (
            <>
              <div {...stylex.props(styles.grid)}>
                {accounts.map((a) => {
                  const handle = a.handle?.trim() || null;
                  const displayName = a.displayName?.trim() ?? "";
                  const primary =
                    displayName.length > 0
                      ? displayName
                      : handle
                        ? `@${handle}`
                        : "Unknown account";
                  const handleLine = displayName.length > 0 && handle ? `@${handle}` : null;
                  const avatarLetter = (displayName[0] ?? handle?.[0] ?? "?").toUpperCase();
                  return (
                    <div {...stylex.props(styles.card)} key={a.did}>
                      <div {...stylex.props(styles.cardUpper)}>
                        <Link
                          to="/u/$identifier"
                          params={{ identifier: handle ?? a.did }}
                          preload="intent"
                          {...stylex.props(styles.identityRowLink)}
                        >
                          <Avatar
                            src={a.avatarUrl ?? undefined}
                            alt={primary}
                            fallback={avatarLetter}
                            size="lg"
                          />
                          <div {...stylex.props(styles.identityText)}>
                            <Text size="lg" leading="none">
                              {primary}
                            </Text>
                            {handleLine ? <Text variant="secondary">{handleLine}</Text> : null}
                          </div>
                        </Link>
                        <div {...stylex.props(styles.badgeSlot)}>
                          {a.isProvider ? (
                            <Badge variant="primary">provider</Badge>
                          ) : (
                            <Badge variant="default">member</Badge>
                          )}
                        </div>
                      </div>
                      <div {...stylex.props(styles.cardDivider)} role="presentation" />
                      <div {...stylex.props(styles.cardLower)}>
                        <div {...stylex.props(styles.statusLine)}>
                          <span {...stylex.props(styles.statusDot)} aria-hidden />
                          <span {...stylex.props(styles.statusText)}>
                            {sortBy === "newest"
                              ? `joined ${relativeTime(a.joinedAt)}`
                              : `active ${relativeTime(a.lastActivityAt)}`}
                          </span>
                        </div>
                        <Button variant="secondary" size="sm" onPress={() => onFriendIntent(a)}>
                          <span {...stylex.props(styles.friendButtonLabel)}>+ friend</span>
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {totalPages > 1 ? (
                <div {...stylex.props(styles.paginationRow)}>
                  <Pagination
                    selectedPage={page}
                    onSelectedPageChange={setPage}
                    totalPages={totalPages}
                    maxVisiblePages={7}
                    size="sm"
                  />
                </div>
              ) : null}
            </>
          )}
        </Flex>
      </CardBody>
    </Card>
  );
}
