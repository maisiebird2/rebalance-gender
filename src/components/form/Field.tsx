interface FieldProps {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  type?: string;
}

/**
 * A labelled text input. When `required` is set, a red asterisk is appended to
 * the label automatically — so pass a plain label ("Name"), not "Name *".
 */
export default function Field({
  label,
  name,
  defaultValue,
  placeholder,
  required,
  type = "text",
}: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 dark:border-gray-700 dark:bg-gray-900"
      />
    </div>
  );
}
