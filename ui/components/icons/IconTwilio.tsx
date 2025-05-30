export const IconTwilio = ({
  size = 24,
  color = "#e31e26",
  className = "",
  ...props
}) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      {...props}
    >
      <g transform="matrix(.937042 0 0 .937042 0 .046624)" fill={color}>
        <path d="M34.1 0C15.3 0 0 15.3 0 34.1s15.3 34.1 34.1 34.1C53 68.3 68.3 53 68.3 34.1S53 0 34.1 0zm0 59.3C20.3 59.3 9 48 9 34.1 9 20.3 20.3 9 34.1 9 48 9 59.3 20.3 59.3 34.1 59.3 48 48 59.3 34.1 59.3z" />
        <circle cx="42.6" cy="25.6" r="7.1" />
        <circle cx="42.6" cy="42.6" r="7.1" />
        <circle cx="25.6" cy="42.6" r="7.1" />
        <circle cx="25.6" cy="25.6" r="7.1" />
      </g>
    </svg>
  );
};
