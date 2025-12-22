export default function DebugPage() {
  return (
    <div>
      <h1 style={{color: 'red', fontSize: '48px', padding: '50px'}}>
        DEBUG PAGE - VISIBLE?
      </h1>
      <div className="bg-blue-500 text-white p-8 text-2xl">
        Testing Tailwind Classes
      </div>
      <div style={{backgroundColor: 'green', color: 'yellow', padding: '20px'}}>
        Inline styles test
      </div>
    </div>
  );
}
