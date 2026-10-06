import styles from "../activity.module.css";

export function JsonDetail({ value }: { value: unknown }) {
  return <pre className={styles.jsonDetail}>{JSON.stringify(value, null, 2)}</pre>;
}
