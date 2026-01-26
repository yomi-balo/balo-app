import { loginAction } from './actions';

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md space-y-8 p-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Welcome to Balo</h1>
          <p className="text-muted-foreground mt-2">Sign in to find or become an expert</p>
        </div>

        <form action={loginAction}>
          <button
            type="submit"
            className="bg-primary text-primary-foreground hover:bg-primary/90 w-full rounded-md px-4 py-2"
          >
            Sign In
          </button>
        </form>
      </div>
    </div>
  );
}
