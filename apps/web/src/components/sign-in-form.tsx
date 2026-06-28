import { Button } from "./ui/button";
import { Input } from "./ui/input";

// Placeholder sign-in form for the app-shell. It presents the fields and copy
// with no behavior wired yet — the authentication flow (validation, submit,
// session) is layered on in a later epic. Rendered standalone so it needs no
// router or auth context.
export default function SignInForm({
  onSwitchToSignUp,
}: {
  onSwitchToSignUp?: () => void;
}) {
  return (
    <div className="mx-auto mt-10 w-full max-w-md p-6">
      <h1 className="mb-6 text-center font-bold text-3xl">Welcome Back</h1>

      <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
        <div className="space-y-2">
          <label className="text-xs" htmlFor="signin-email">
            Email
          </label>
          <Input
            autoComplete="email"
            id="signin-email"
            name="email"
            placeholder="you@example.com"
            type="email"
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs" htmlFor="signin-password">
            Password
          </label>
          <Input
            autoComplete="current-password"
            id="signin-password"
            name="password"
            placeholder="Your password"
            type="password"
          />
        </div>

        <Button className="w-full" disabled type="submit">
          Sign In
        </Button>
      </form>

      {onSwitchToSignUp ? (
        <div className="mt-4 text-center">
          <Button onClick={onSwitchToSignUp} type="button" variant="link">
            Need an account? Sign Up
          </Button>
        </div>
      ) : null}
    </div>
  );
}
