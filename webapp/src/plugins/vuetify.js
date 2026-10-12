import "vuetify/styles";
import { h } from "vue";
import { createVuetify } from "vuetify";
import { VSvgIcon } from "vuetify/components/VIcon";
import { aliases } from "vuetify/iconsets/mdi-svg";
import { icons } from "./icons";

// The `mdi` icon set resolves the `mdi-*` names used in the templates to
// the SVG paths bundled in icons.js. Vuetify's own `$` aliases ($expand,
// $close and friends) carry their path and use its built-in `svg` set.
function MdiIcon(props) {
  const path = icons[props.icon];
  if (!path) {
    if (import.meta.env.DEV) {
      console.warn(`Icon "${props.icon}" is not listed in src/plugins/icons.js`);
    }
    return null;
  }
  return h(VSvgIcon, { icon: path, tag: props.tag });
}
MdiIcon.props = { icon: String, tag: String };

export default createVuetify({
  icons: {
    defaultSet: "mdi",
    aliases,
    sets: { mdi: { component: MdiIcon } },
  },
  theme: {
    defaultTheme: "light",
    themes: {
      light: {
        colors: {
          primary: "#ce9160",
          secondary: "#424242",
          accent: "#82B1FF",
          error: "#982f2f",
          info: "#2f6398",
          success: "#2f9852",
          warning: "#987e2f",
        },
      },
    },
  },
  defaults: {
    VBtn: {
      variant: "flat",
    },
    VCard: {
      elevation: 2,
    },
  },
});
