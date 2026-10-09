import { createFileRoute } from "@tanstack/react-router";
import { DropApp } from "@/components/drop/drop-app";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <DropApp />;
}
