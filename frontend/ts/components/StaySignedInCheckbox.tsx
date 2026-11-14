import { useId } from 'react';

type StaySignedInCheckboxProps = {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
};

/** Shared presentation; the form owns the choice and the server owns its lifetime. */
export default function StaySignedInCheckbox({ checked, onChange, disabled = false }: StaySignedInCheckboxProps) {
    const id = useId();
    const description = 'Renews while you use the site. Expires after 30 days without use.';

    return (
        <label className="stay-signed-in" htmlFor={id} title={description}>
            <input
                id={id}
                className="stay-signed-in__input"
                type="checkbox"
                name="remember_me"
                checked={checked}
                disabled={disabled}
                aria-describedby={`${id}-description`}
                onChange={(event) => onChange(event.target.checked)}
            />
            <span className="stay-signed-in__indicator" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                    <path d="m6 12 4 4 8-8" />
                </svg>
            </span>
            <span>Stay signed in</span>
            <span className="stay-signed-in__description" id={`${id}-description`}>
                {description}
            </span>
        </label>
    );
}
