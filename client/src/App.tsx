import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/Home";
import SermonMode from "@/pages/SermonMode";
import NotFound from "@/pages/not-found";

// Preekmodus (per-sentence editable translation review) is the front door —
// it's the workflow the app was built for. Live/subtitle mode moved to
// /live; /sermon redirects to / so old bookmarks/links keep working.
function Router() {
  return (
    <Switch>
      <Route path="/" component={SermonMode} />
      <Route path="/live" component={Home} />
      <Route path="/sermon">
        <Redirect to="/" />
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
