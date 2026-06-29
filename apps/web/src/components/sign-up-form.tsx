import { Button } from "./ui/button";
import { Input } from "./ui/input";

// Placeholder sign-up form for the app-shell. It presents the fields and copy
// with no behavior wired yet — the authentication flow (validation, submit,
// session) is layered on in a later epic. Rendered standalone so it needs no
// router or auth context. Mirrors sign-in-form's placeholder treatment.
export default function SignUpForm({
  onSwitchToSignIn,
}: {
  onSwitchToSignIn?: () => void;
}) {
  return (
    <div className="mx-auto mt-10 w-full max-w-md p-6">
      <h1 className="mb-6 text-center font-bold text-3xl">Create Account</h1>

      <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
        <div className="space-y-2">
          <label className="text-xs" htmlFor="signup-name">
            Name
          </label>
          <Input
            autoComplete="name"
            id="signup-name"
            name="name"
            placeholder="Your name"
            type="text"
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs" htmlFor="signup-email">
            Email
          </label>
          <Input
            autoComplete="email"
            id="signup-email"
            name="email"
            placeholder="you@example.com"
            type="email"
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs" htmlFor="signup-password">
            Password
          </label>
          <Input
            autoComplete="new-password"
            id="signup-password"
            name="password"
            placeholder="Create a password"
            type="password"
          />
        </div>

        <Button className="w-full" disabled type="submit">
          Sign Up
        </Button>
      </form>

      {onSwitchToSignIn ? (
        <div className="mt-4 text-center">
          <Button onClick={onSwitchToSignIn} type="button" variant="link">
            Already have an account? Sign In
          </Button>
        </div>
      ) : null}
    </div>
  );
}
