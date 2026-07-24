/**
 * @file    src/components/dashboard/chips/chips.test.tsx
 * @purpose Smoke tests for the three chip/badge primitives.
 *          Tests basic rendering, prop reactivity, and onClick wiring.
 *          Uses plain DOM assertions (no jest-dom / user-event) to match
 *          the existing house test convention in this repo — see
 *          InvoiceQueuePanel.test.tsx / AxiomSkuMappingPanel.test.tsx.
 * @author  delegated engineer (via Hermia oversight)
 * @created 2026-07-24
 * @vitest-environment jsdom
 */
// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

import { FilterChip, StatusBadge, ActionChip } from "./index";

// ---------------------------------------------------------------------------
// FilterChip
// ---------------------------------------------------------------------------
describe("FilterChip", () => {
  it("renders label text", () => {
    render(<FilterChip label="TODAY" active={false} onClick={vi.fn()} />);
    expect(screen.getByText("TODAY")).not.toBeNull();
  });

  it("renders count when provided", () => {
    render(<FilterChip label="TODAY" count={3} active={false} onClick={vi.fn()} />);
    expect(screen.getByText("3")).not.toBeNull();
  });

  it("fires onClick when clicked", () => {
    const onClick = vi.fn();
    render(<FilterChip label="TODAY" active={false} onClick={onClick} />);
    fireEvent.click(screen.getByText("TODAY"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("applies active classes when active=true", () => {
    const { container } = render(
      <FilterChip label="TODAY" active={true} onClick={vi.fn()} tone="red" />
    );
    const btn = container.querySelector("button");
    expect(btn).not.toBeNull();
    // Active chip should have tinted bg
    expect(btn!.className).toContain("bg-red-500/15");
    expect(btn!.className).toContain("text-red-300");
  });

  it("applies inactive classes when active=false", () => {
    const { container } = render(
      <FilterChip label="TODAY" active={false} onClick={vi.fn()} />
    );
    const btn = container.querySelector("button");
    expect(btn).not.toBeNull();
    expect(btn!.className).toContain("bg-transparent");
  });

  it("renders with custom tone", () => {
    const { container } = render(
      <FilterChip label="Test" active={true} onClick={vi.fn()} tone="amber" />
    );
    const btn = container.querySelector("button");
    expect(btn!.className).toContain("bg-amber-500/15");
  });

  it("sets title attribute when provided", () => {
    render(
      <FilterChip label="Test" active={false} onClick={vi.fn()} title="Tooltip text" />
    );
    expect(screen.getByTitle("Tooltip text")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------
describe("StatusBadge", () => {
  it("renders label text", () => {
    render(<StatusBadge label="In Transit" tone="cyan" />);
    expect(screen.getByText("In Transit")).not.toBeNull();
  });

  it("renders as <span> (not interactive)", () => {
    const { container } = render(<StatusBadge label="Test" tone="neutral" />);
    const el = container.querySelector("span");
    expect(el).not.toBeNull();
    // Should NOT contain cursor-pointer or hover classes
    expect(el!.className).not.toContain("cursor-pointer");
    // Should not render as a button element anywhere
    expect(container.querySelector("button")).toBeNull();
  });

  it("applies tone styles correctly", () => {
    const { container } = render(<StatusBadge label="OVERDUE" tone="red" />);
    const el = container.querySelector("span");
    expect(el!.className).toContain("bg-red-500/20");
    expect(el!.className).toContain("text-red-300");
  });

  it("renders every valid tone without error", () => {
    const tones = ["red", "amber", "orange", "cyan", "emerald", "rose", "neutral"] as const;
    for (const tone of tones) {
      const { unmount } = render(<StatusBadge label={tone} tone={tone} />);
      expect(screen.getByText(tone)).not.toBeNull();
      unmount();
    }
  });

  it("renders icon when provided", () => {
    const { container } = render(
      <StatusBadge label="Test" tone="cyan" icon={<span data-testid="icon">🚚</span>} />
    );
    expect(container.querySelector('[data-testid="icon"]')).not.toBeNull();
  });

  it("applies rounded-md class (distinct from FilterChip's rounded)", () => {
    const { container } = render(<StatusBadge label="Test" tone="neutral" />);
    const el = container.querySelector("span");
    expect(el!.className).toContain("rounded-md");
  });
});

// ---------------------------------------------------------------------------
// ActionChip
// ---------------------------------------------------------------------------
describe("ActionChip", () => {
  it("renders label text", () => {
    render(<ActionChip label="Order Now" onClick={vi.fn()} />);
    expect(screen.getByText("Order Now")).not.toBeNull();
  });

  it("renders count in parentheses when provided", () => {
    render(<ActionChip label="Order Now" count={2} onClick={vi.fn()} />);
    const btn = screen.getByRole("button");
    expect(btn.textContent).toContain("(2)");
  });

  it("fires onClick when clicked", () => {
    const onClick = vi.fn();
    render(<ActionChip label="Order Now" onClick={onClick} />);
    fireEvent.click(screen.getByText("Order Now"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is disabled and dimmed when disabled=true", () => {
    const onClick = vi.fn();
    const { container } = render(
      <ActionChip label="Order Now" onClick={onClick} disabled={true} />
    );
    const btn = container.querySelector("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.className).toContain("opacity-40");
    expect(btn.className).toContain("cursor-not-allowed");
  });

  it("does NOT fire onClick when disabled", () => {
    const onClick = vi.fn();
    render(<ActionChip label="Order Now" onClick={onClick} disabled={true} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("applies primary variant by default", () => {
    const { container } = render(<ActionChip label="Order Now" onClick={vi.fn()} />);
    const btn = container.querySelector("button");
    expect(btn!.className).toContain("bg-emerald-600/30");
  });

  it("applies secondary variant when specified", () => {
    const { container } = render(
      <ActionChip label="Re-scan" onClick={vi.fn()} variant="secondary" />
    );
    const btn = container.querySelector("button");
    expect(btn!.className).toContain("bg-zinc-800");
    expect(btn!.className).not.toContain("bg-emerald-600/30");
  });

  it("applies font-semibold (distinct from FilterChip/StatusBadge)", () => {
    const { container } = render(<ActionChip label="Go" onClick={vi.fn()} />);
    const btn = container.querySelector("button");
    expect(btn!.className).toContain("font-semibold");
  });
});
