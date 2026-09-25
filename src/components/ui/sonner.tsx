import { useTheme } from "next-themes";
import { Toaster as Sonner, toast } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * Game notifications. The look lives in `index.css` under "Toasts": each type
 * gets its own accent (gold = good news, red = trouble, amber = warning,
 * steel = information) as a left bar, tinted glass and a short entry flash so
 * a result never blends into the panels behind it.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="bottom-left"
      offset={{ bottom: 20, left: 64 }}
      duration={5500}
      closeButton
      expand
      visibleToasts={4}
      gap={10}
      toastOptions={{
        classNames: {
          toast: "group toast",
          title: "toast-title",
          description: "toast-description",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
