import { createFileRoute } from "@tanstack/react-router";

import { ChangePasswordForm } from "@/components/auth/change-password-form";

export const Route = createFileRoute("/change-password")({
  component: () => <ChangePasswordForm />,
});
