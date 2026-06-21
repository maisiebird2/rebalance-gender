"use client";

import { useRef, useState, useTransition } from "react";
import { addGenre } from "./actions";

export default function AddGenreForm() {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    const formData = new FormData(e.currentTarget);

    startTransition(async () => {
      const result = await addGenre(formData);
      if (result && "error" in result) {
        setError(result.error);
      } else {
        setSuccess(true);
        formRef.current?.reset();
      }
    });
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="genre-name" className="text-sm font-medium">
            New genre
          </label>
          <input
            id="genre-name"
            name="name"
            type="text"
            placeholder="e.g. deep house"
            required
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-60"
        >
          {isPending ? "Adding…" : "Add"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {success && <p className="text-sm text-green-600 dark:text-green-400">Added.</p>}
    </form>
  );
}
