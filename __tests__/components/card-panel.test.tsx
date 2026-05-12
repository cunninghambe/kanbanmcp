// @vitest-environment jsdom
/**
 * Tests for CardModal component — M1 panel sections
 * Validates rendering order and that PATCH is called on role changes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

// Mock swr to control data
vi.mock("swr", () => ({
  default: vi.fn(),
}));

// Mock child components that are complex to test at this level
vi.mock("../../src/components/board/ArtifactList", () => ({
  ArtifactList: ({ cardId }: { cardId: string }) => (
    <div data-testid="artifact-list" data-card-id={cardId} />
  ),
}));

vi.mock("../../src/components/board/SignoffPanel", () => ({
  SignoffPanel: ({ role }: { role: string }) => (
    <div data-testid={`signoff-panel-${role}`} />
  ),
}));

import useSWR from "swr";
import { CardModal } from "../../src/components/board/CardModal";
import { mockSWR } from "./_helpers/mock-swr";

const mockUseSWR = vi.mocked(useSWR);

const baseCard: {
  id: string;
  title: string;
  description: string;
  assigneeId: string | null;
  reviewerId: string | null;
  approverId: string | null;
  parentCardId: string | null;
  depth: number;
  aiAutoReview: boolean;
  aiReviewParams: null;
  dueDate: null;
  agentId: null;
  priority: string;
  createdAt: string;
  columnId: string;
  sprintId: null;
  labels: { label: { id: string; name: string; color: string } }[];
  comments: never[];
  assignee: { id: string; name: string; email: string } | null;
  reviewer: { id: string; name: string; email: string } | null;
  approver: null;
  parent: { id: string; title: string; aiReviewParams: null } | null;
  _count: { children: number };
} = {
  id: "card-1",
  title: "Test card",
  description: "A description",
  assigneeId: "user-1",
  reviewerId: "user-2",
  approverId: null,
  parentCardId: null,
  depth: 0,
  aiAutoReview: false,
  aiReviewParams: null,
  dueDate: null,
  agentId: null,
  priority: "medium",
  createdAt: new Date("2026-01-01").toISOString(),
  columnId: "col-1",
  sprintId: null,
  labels: [],
  comments: [],
  assignee: { id: "user-1", name: "Alice", email: "alice@example.com" },
  reviewer: { id: "user-2", name: "Bob", email: "bob@example.com" },
  approver: null,
  parent: null,
  _count: { children: 0 },
};

const orgMembers = [
  {
    userId: "user-1",
    user: {
      id: "user-1",
      name: "Alice",
      email: "alice@example.com",
      isAgent: false,
    },
  },
  {
    userId: "user-2",
    user: {
      id: "user-2",
      name: "Bob",
      email: "bob@example.com",
      isAgent: false,
    },
  },
];

function setupMocks({ currentUserId = "user-99", card = baseCard } = {}) {
  const cardMutate = vi.fn();
  const signoffMutate = vi.fn();

  mockUseSWR.mockImplementation((key) => {
    const keyStr = Array.isArray(key) ? key[0] : key;

    if (typeof key === "string" && key.includes("/api/cards/")) {
      return mockSWR({ data: { card }, mutate: cardMutate });
    }

    if (typeof key === "string" && key.includes("/api/orgs/")) {
      return mockSWR({ data: { members: orgMembers } });
    }

    if (typeof key === "string" && key.includes("/api/boards/")) {
      return mockSWR({ data: { labels: [] } });
    }

    if (keyStr === "signoffs") {
      return mockSWR({
        data: { signoffs: [], latest: { reviewer: null, approver: null } },
        mutate: signoffMutate,
      });
    }

    // Session
    return mockSWR({
      data: {
        user: {
          id: currentUserId,
          name: "Test User",
          email: "test@example.com",
        },
        orgMemberships: [{ org: { id: "org-1", role: "MEMBER" } }],
      },
    });
  });

  return { cardMutate, signoffMutate };
}

describe("CardModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ card: baseCard }),
    });
    global.confirm = vi.fn().mockReturnValue(true);
  });

  it("renders sections in documented order: Roles, AI Auto-Review, Artifacts, Signoffs, Comments", () => {
    setupMocks();

    render(
      <CardModal
        cardId="card-1"
        boardId="board-1"
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const headings = screen.getAllByRole("heading", { level: 3 });
    const headingTexts = headings.map((h) => h.textContent);

    expect(headingTexts).toContain("Roles");
    expect(headingTexts).toContain("AI Auto-Review");
    expect(headingTexts).toContain("Artifacts");
    expect(headingTexts).toContain("Signoffs");
    expect(headingTexts).toContain("Comments");

    // Order check
    const rolesIdx = headingTexts.indexOf("Roles");
    const aiIdx = headingTexts.indexOf("AI Auto-Review");
    const artifactsIdx = headingTexts.indexOf("Artifacts");
    const signoffsIdx = headingTexts.indexOf("Signoffs");
    const commentsIdx = headingTexts.indexOf("Comments");

    expect(rolesIdx).toBeLessThan(aiIdx);
    expect(aiIdx).toBeLessThan(artifactsIdx);
    expect(artifactsIdx).toBeLessThan(signoffsIdx);
    expect(signoffsIdx).toBeLessThan(commentsIdx);
  });

  it("renders role selectors for Assignee, Reviewer, and Approver", () => {
    setupMocks();

    render(
      <CardModal
        cardId="card-1"
        boardId="board-1"
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    // Within the Roles section — the Assignee label includes an asterisk for required
    expect(screen.getAllByLabelText(/Assignee/)[0]).toBeInTheDocument();
    expect(screen.getByLabelText("Reviewer")).toBeInTheDocument();
    expect(screen.getByLabelText("Approver")).toBeInTheDocument();
  });

  it("calls PATCH with reviewerId when reviewer is changed", async () => {
    const user = userEvent.setup();
    setupMocks();

    render(
      <CardModal
        cardId="card-1"
        boardId="board-1"
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const reviewerSelect = screen.getByLabelText("Reviewer");
    await user.selectOptions(reviewerSelect, "user-1");

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/cards/card-1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ reviewerId: "user-1" }),
        }),
      );
    });
  });

  it("shows ArtifactList with the current cardId", () => {
    setupMocks();

    render(
      <CardModal
        cardId="card-1"
        boardId="board-1"
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const artifactList = screen.getByTestId("artifact-list");
    expect(artifactList).toHaveAttribute("data-card-id", "card-1");
  });

  it("does NOT show SignoffPanel when current user is not reviewer or approver", () => {
    setupMocks({ currentUserId: "user-99" }); // not reviewer (user-2) or approver

    render(
      <CardModal
        cardId="card-1"
        boardId="board-1"
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(
      screen.queryByTestId("signoff-panel-REVIEWER"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("signoff-panel-APPROVER"),
    ).not.toBeInTheDocument();
  });

  it("shows REVIEWER SignoffPanel when current user is the reviewer", () => {
    setupMocks({ currentUserId: "user-2" }); // user-2 is reviewerId

    render(
      <CardModal
        cardId="card-1"
        boardId="board-1"
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByTestId("signoff-panel-REVIEWER")).toBeInTheDocument();
    expect(
      screen.queryByTestId("signoff-panel-APPROVER"),
    ).not.toBeInTheDocument();
  });

  it("shows parent breadcrumb when card has parentCardId", () => {
    const cardWithParent = {
      ...baseCard,
      parentCardId: "parent-card-1" as string | null,
      parent: {
        id: "parent-card-1",
        title: "Parent Epic",
        aiReviewParams: null,
      },
    };
    setupMocks({ card: cardWithParent });

    render(
      <CardModal
        cardId="card-1"
        boardId="board-1"
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText(/Sub-card of/i)).toBeInTheDocument();
    expect(screen.getByText("Parent Epic")).toBeInTheDocument();
  });

  it("shows loading state when card data is not yet available", () => {
    mockUseSWR.mockReturnValue(mockSWR({ data: undefined, isLoading: true }));

    render(
      <CardModal
        cardId="card-1"
        boardId="board-1"
        onClose={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});
