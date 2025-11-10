import Header from '../Header';

export default function HeaderExample() {
  return <Header onThemeToggle={() => console.log('Theme toggle clicked')} />;
}
