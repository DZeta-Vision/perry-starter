import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/login")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  const [showSignIn, setShowSignIn] = useState(false);

  // Sign-in calls the cloud authority via the auth client; a failed attempt
  // surfaces the SAME generic copy (thrown so the form's catch renders it),
  // never a state- or existence-revealing message.
  const handleSignIn = async ({
    email,
    password,
  }: {
    email: string;
    password: string;
  }) => {
    const { error } = await authClient.signIn.email({ email, password });
    if (error) {
      throw new Error("sign-in failed");
    }
    await navigate({ to: "/dashboard" });
  };

  return showSignIn ? (
    <SignInForm
      onSubmit={handleSignIn}
      onSwitchToSignUp={() => setShowSignIn(false)}
    />
  ) : (
    <SignUpForm onSwitchToSignIn={() => setShowSignIn(true)} />
  );
}
