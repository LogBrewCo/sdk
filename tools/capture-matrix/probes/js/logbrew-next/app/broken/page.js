export const dynamic = "force-dynamic";

export default function BrokenPage() {
  throw new Error("cart render failed");
}
