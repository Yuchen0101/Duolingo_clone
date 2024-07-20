import dynamic from "next/dynamic";
import { redirect } from "next/navigation";

import { getIsAdmin } from "@/lib/admin";

// 懒加载
const App = dynamic(() => import("./app"), { ssr: false }); // 不提前SSR渲染

const AdminPage = () => {
  const isAdmin = getIsAdmin();

  if (!isAdmin) redirect("/");

  return (
    <div>
      <App />
    </div>
  );
};

export default AdminPage;
